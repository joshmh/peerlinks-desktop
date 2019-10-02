/* eslint-env node */
import { Buffer } from 'buffer';

import PeerLinks, { Message } from '@peerlinks/protocol';
import SqliteStorage from '@peerlinks/sqlite-storage';
import Swarm from '@peerlinks/swarm';

import log from 'electron-log';
import * as sodium from 'sodium-universal';
import WaitList from 'promise-waitlist';
import * as bs58 from 'bs58';

const INVITE_TIMEOUT = 15 * 60 * 1000; // 15 minutes

export default class Network {
  constructor (ipc, options = {}) {
    this.ipc = ipc;
    this.options = options;
    if (!this.options.db) {
      throw new Error('Missing `options.db`');
    }
    if (!this.options.setBadgeCount) {
      throw new Error('Missing `options.setBadgeCount`');
    }

    this.storage = null;
    this.peerLinks = null;
    this.swarm = null;

    this.waitList = new WaitList();

    // Map<Channel, WaitList.Entry>
    this.updateLoops = new WeakMap();

    // WeakSet<Channel>
    this.updatedChannels = new WeakSet();

    // `true` when chain map was recently updated
    this.chainMapUpdated = false;

    // Map<identityKey, Function>
    this.pendingInvites = new Map();

    this.isReady = false;

    this.initIPC();
  }

  async init () {
    this.storage = new SqliteStorage({ file: this.options.db });
    await this.storage.open();

    this.peerLinks = await this.waitList.waitFor('init');
    for (const channel of this.peerLinks.channels) {
      this.runUpdateLoop(channel);
    }

    this.runChainLoop();

    this.swarm = new Swarm(this.peerLinks);
    this.waitList.resolve('ready');
    this.isReady = true;
  }

  initIPC () {
    const ipc = this.ipc;

    const handle = (type, handler, requireReady = true) => {
      ipc.on(`network:${type}`, (event, { seq, payload }) => {
        log.info(`network: got ${type}`);

        if (!this.isReady && requireReady) {
          log.info(`network: not ready to "${type}" seq=${seq}`);
          return event.reply('response', { seq, error: 'Not ready' });
        }

        handler(payload).then((result) => {
          log.info(`network: responding to "${type}" seq=${seq}`);
          event.reply('response', { seq, payload: result });
        }).catch((err) => {
          log.info(`network: error to "${type}" seq=${seq}`);
          event.reply(
            'response',
            { seq, error: err.message, stack: err.stack }
          );
        });
      });
    };

    handle('init', async ({ passphrase }) => {
      if (this.isReady) {
        // Already initialized
        return;
      }

      const peerLinks = new PeerLinks({
        sodium,
        storage: this.storage,
        passphrase,
      });
      if (!await peerLinks.load()) {
        throw new Error('Invalid passphrase');
      }

      this.waitList.resolve('init', peerLinks);

      await this.waitList.waitFor('ready');

      return {
        peerId: this.peerLinks.id.toString('hex'),
      };
    }, false);

    handle('erase', async () => {
      await this.storage.clear();
    }, false);

    handle('getStatus', async () => {
      const isFirstRun = (await this.storage.getEntityCount()) === 0;
      return {
        isReady: this.isReady,
        isFirstRun,
        peerId: this.isReady ?
          this.peerLinks.id.toString('hex') : null,
      };
    }, false);

    handle('getChannels', async () => {
      return await Promise.all(this.peerLinks.channels.map(async (channel) => {
        return await this.serializeChannel(channel);
      }));
    });

    handle('getIdentities', async () => {
      return this.peerLinks.identities.map((identity) => {
        return this.serializeIdentity(identity);
      });
    });

    handle('createIdentityPair', async ({ name, isFeed }) => {
      const [ identity, channel ] =
        await this.peerLinks.createIdentityPair(name, { isFeed });
      this.runUpdateLoop(channel);

      return {
        identity: this.serializeIdentity(identity),
        channel: await this.serializeChannel(channel),
      };
    });

    handle('feedFromPublicKey', async ({ publicKey, name }) => {
      try {
        publicKey = bs58.decode(publicKey);
      } catch (e) {
        throw new Error('Invalid encoding of publicKey');
      }

      log.info(`creating channel from public key=${publicKey.toString('hex')}`);
      const channel = await this.peerLinks.feedFromPublicKey(publicKey, { name });

      this.swarm.joinChannel(channel);
      await this.updateBadge();
      this.runUpdateLoop(channel);

      return await this.serializeChannel(channel);
    });

    const channelById = (id) => {
      id = Buffer.from(id, 'hex');
      return this.peerLinks.channels.find((channel) => {
        return channel.id.equals(id);
      });
    };

    const identityByKey = (key) => {
      key = Buffer.from(key, 'hex');
      return this.peerLinks.identities.find((identity) => {
        return identity.publicKey.equals(key);
      });
    };

    handle('removeIdentityPair', async ({ channelId, identityKey }) => {
      const channel = channelById(channelId);
      if (channel) {
        await this.peerLinks.removeChannel(channel);
      }

      const identity = identityByKey(identityKey);
      if (identity) {
        await this.peerLinks.removeIdentity(identity);
      }

      await this.updateBadge();
      this.waitList.resolve('update:' + channel.id.toString('hex'), false);

      // Cancel pending invites
      if (this.pendingInvites.has(identityKey)) {
        const pending = this.pendingInvites.get(identityKey);
        if (pending.waiter) {
          pending.waiter.cancel();
        }
      }
    });

    handle('updateChannelMetadata', async ({ channelId, metadata }) => {
      const channel = channelById(channelId);
      if (!channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      channel.setMetadata({
        ...channel.metadata,
        ...metadata,
      });
      await this.peerLinks.saveChannel(channel);
      await this.updateBadge();
    });

    handle('getMessageCount', async ({ channelId }) => {
      const channel = channelById(channelId);
      if (!channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      return await channel.getMessageCount();
    });

    handle('getReverseMessagesAtOffset', async ({ channelId, offset, limit }) => {
      const channel = channelById(channelId);
      if (!channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      const messages = await channel.getReverseMessagesAtOffset(offset, limit);
      return messages.map((message) => {
        return this.serializeMessage(message);
      });
    });

    handle('waitForIncomingMessage', async ({ channelId, timeout }) => {
      const channel = channelById(channelId);
      if (!channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      // We might have been already updated between `waitForIncomingMessage`
      // calls.
      if (this.updatedChannels.has(channel)) {
        this.updatedChannels.delete(channel);
        log.info(`network: waitForIncomingMessage ${channelId} ... immediate`);
        return true;
      }

      // Otherwise - wait
      log.info(`network: waitForIncomingMessage ${channelId} ... wait`);
      const entry = this.waitList.waitFor('update:' + channelId.toString('hex'), timeout);
      const isAlive = await entry;
      this.updatedChannels.delete(channel);
      return isAlive;
    });

    handle('postMessage', async ({ channelId, identityKey, json }) => {
      const channel = channelById(channelId);
      if (!channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      const identity = identityByKey(identityKey);
      if (!identity) {
        throw new Error('Identity not found: ' + identityKey);
      }

      log.info(`network: postMessage ${channelId} id=${identity.name}`);

      const message = await channel.post(Message.json(json), identity);
      return this.serializeMessage(message);
    });

    handle('requestInvite', async ({ identityKey }) => {
      const identity = identityByKey(identityKey);
      if (!identity) {
        throw new Error('Identity not found: ' + identityKey);
      }

      log.info(`network: requestInvite id=${identity.name}`);

      if (this.pendingInvites.has(identityKey)) {
        const existing = this.pendingInvites.get(identityKey);
        return {
          request: existing.encoded,
        };
      }

      const { requestId, request, decrypt } =
        identity.requestInvite(this.peerLinks.id);

      const encoded = bs58.encode(request);
      this.pendingInvites.set(identityKey, {
        requestId,
        decrypt,
        encoded,

        // To be set below
        waiter: null,
      });

      return {
        request: encoded,
      };
    });

    handle('waitForInvite', async ({ identityKey }) => {
      const identity = identityByKey(identityKey);
      if (!identity) {
        throw new Error('Identity not found: ' + identityKey);
      }

      if (!this.pendingInvites.has(identityKey)) {
        throw new Error('No pending invites for: ' + identity.name);
      }

      const entry = this.pendingInvites.get(identityKey);

      // Already waiting
      if (entry.waiter) {
        entry.waiter.cancel();
      }

      entry.waiter = this.swarm.waitForInvite(entry.requestId);

      let encryptedInvite;
      try {
        encryptedInvite = await entry.waiter;
      } catch (e) {
        log.error(`network: waitForInvite error ${e.message}`);

        // Likely canceled
        return false;
      } finally {
        entry.waiter = null;
      }

      const invite = entry.decrypt(encryptedInvite);

      // Find suitable channel name
      let channelName = invite.channelName;
      let counter = 0;
      let existing;
      for (;;) {
        existing = this.peerLinks.getChannel(channelName);
        if (!existing) {
          break;
        }

        if (existing.id.equals(invite.channelPubKey)) {
          // Just add the chain, the `channelFromInvite` will not throw
          break;
        }

        counter++;
        channelName = `${invite.channelName}-${counter}`;
      }

      const channel = await this.peerLinks.channelFromInvite(invite, identity, {
        name: channelName,
      });
      channel.setMetadata({
        ...channel.metadata,
        isFeed: false,
      });
      await this.peerLinks.saveChannel(channel);
      await this.updateBadge();

      this.swarm.joinChannel(channel);
      this.runUpdateLoop(channel);

      // Cleanup
      this.pendingInvites.delete(identityKey);

      return await this.serializeChannel(channel);
    });

    handle('invite', async (params) => {
      let {
        identityKey, channelId, inviteeName, request,
      } = params;

      const channel = channelById(channelId);
      if (!channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      try {
        request = bs58.decode(request);
      } catch (e) {
        throw new Error('Invalid encoding of invite');
      }

      const identity = identityByKey(identityKey);
      if (!identity) {
        throw new Error('Identity not found: ' + identityKey);
      }

      const { encryptedInvite, peerId } =
        identity.issueInvite(channel, request, inviteeName);

      return {
        encryptedInvite: {
          box: bs58.encode(encryptedInvite.box),
          requestId: bs58.encode(encryptedInvite.requestId),
        },
        peerId: peerId.toString('hex'),
      };
    });

    handle('sendInvite', async ({ peerId, encryptedInvite }) => {
      peerId = Buffer.from(peerId, 'hex');
      encryptedInvite = {
        box: bs58.decode(encryptedInvite.box),
        requestId: bs58.decode(encryptedInvite.requestId),
      };

      return await this.swarm.sendInvite({
        peerId,
        encryptedInvite,
      }, INVITE_TIMEOUT);
    });

    handle('acceptInvite', async ({ requestId, box }) => {
      const encryptedInvite = {
        requestId: bs58.decode(requestId),
        box: bs58.decode(box),
      };

      return await this.swarm.sendInvite({
        peerId: this.peerLinks.id,
        encryptedInvite,
      }, INVITE_TIMEOUT);
    });

    handle('renameIdentityPair', async (params) => {
      const { channelId, identityKey, newName } = params;

      const channel = channelId && channelById(channelId);
      const identity = identityKey && identityByKey(identityKey);

      if (channelId && !channel) {
        throw new Error('Channel not found: ' + channelId);
      }

      if (identityKey && !identity) {
        throw new Error('Identity not found: ' + identityKey);
      }

      if (this.peerLinks.getChannel(newName)) {
        throw new Error(`Channel with name: "${newName}" already exists`);
      }

      if (this.peerLinks.getIdentity(newName)) {
        throw new Error(`Identity with name: "${newName}" already exists`);
      }

      if (channel) {
        log.info(`renaming channel "${channel.name}" => "${newName}"`);
        channel.name = newName;
        await this.peerLinks.saveChannel(channel);
        await this.updateBadge();
      }

      if (identity) {
        log.info(`renaming identity "${identity.name}" => "${newName}"`);
        identity.name = newName;
        await this.peerLinks.saveIdentity(identity);
      }
    });

    handle('waitForChainMapUpdate', async ({ timeout }) => {
      // We might have been already updated between `waitForIncomingMessage`
      // calls.
      if (this.chainMapUpdated) {
        this.chainMapUpdated = false;
        log.info('network: waitForChainMapUpdate ... immediate');
        return;
      }

      // Otherwise - wait
      log.info('network: waitForChainMapUpdate ... wait');
      const entry = this.waitList.waitFor('chain-map-update', timeout);
      await entry;
      this.chainMapUpdated = false;
    });

    handle('computeChainMap', async () => {
      const chainMap = this.peerLinks.computeChainMap();

      const result = [];
      for (const [ channel, chains ] of chainMap) {
        result.push({
          channelId: channel.id.toString('hex'),
          chains: chains.map((chain) => {
            return {
              publicKeys: chain.getPublicKeys()
                .map((key) => key.toString('hex')),
              displayPath: chain.getDisplayPath(),
            };
          }),
        });
      }
      return result;
    });
  }

  async runUpdateLoop (channel, timeout) {
    // Channel removed
    if (!this.peerLinks.channels.includes(channel)) {
      return;
    }

    if (this.updateLoops.has(channel)) {
      return;
    }

    const entry = channel.waitForIncomingMessage(timeout);
    this.updateLoops.set(channel, entry);
    try {
      log.info(`network: waiting for ${channel.debugId} update`);
      await entry;
      log.info(`network: got ${channel.debugId} update`);

      await this.updateBadge();

      this.updatedChannels.add(channel);

      this.waitList.resolve('update:' + channel.id.toString('hex'), true);
    } catch (e) {
      log.info(`network: channel update loop error ${e.stack}`);
      return;
    } finally {
      this.updateLoops.delete(channel);
    }

    return await this.runUpdateLoop(channel, timeout);
  }

  async runChainLoop () {
    for (;;) {
      try {
        if (!await this.peerLinks.waitForChainMapUpdate()) {
          continue;
        }
      } catch (e) {
        log.error(`chain loop error: ${e.stack}`);
        break;
      }

      this.chainMapUpdated = true;
      this.waitList.resolve('chain-map-update');
    }
  }

  serializeIdentity (identity) {
    return {
      name: identity.name,
      publicKey: identity.publicKey.toString('hex'),
      publicKeyB58: bs58.encode(identity.publicKey),
      channelIds: identity.getChannelIds().map((id) => id.toString('hex')),
      metadata: identity.getMetadata() || {},
    };
  }

  async serializeChannel (channel) {
    const [ last ] =  await channel.getReverseMessagesAtOffset(0);
    return {
      id: channel.id.toString('hex'),
      publicKey: channel.publicKey.toString('hex'),
      publicKeyB58: bs58.encode(channel.publicKey),

      name: channel.name,
      isFeed: channel.isFeed,

      metadata: channel.getMetadata() || {},
      messageCount: await channel.getMessageCount(),
      maxHeight: last ? last.height : 0,
    };
  }

  serializeMessage (message) {
    const author = message.getAuthor();

    return {
      hash: message.hash.toString('hex'),
      height: message.height,
      author: {
        publicKeys: author.publicKeys.map((key) => key.toString('hex')),
        displayPath: author.displayPath,
      },
      timestamp: message.timestamp,
      isRoot: message.isRoot,
      json: message.json,
    };
  }

  async updateBadge () {
    let unread = 0;
    for (const channel of this.peerLinks.channels) {
      const messageCount = await channel.getMessageCount();
      const readCount = (channel.metadata && channel.metadata.readCount) || 0;

      unread += Math.max(messageCount - readCount, 0);
    }

    this.options.setBadgeCount(unread);
  }

  async close () {
    if (this.peerLinks) {
      await this.peerLinks.close();
    }
    if (this.swarm) {
      await this.swarm.destroy();
    }
    if (this.storage) {
      await this.storage.close();
    }

    this.waitList.close(new Error('Closed'));
  }
}
