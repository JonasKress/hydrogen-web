/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {MEGOLM_ALGORITHM} from "../common.js";

export class Encryption {
    constructor({pickleKey, olm, account, storage, now, ownDeviceId}) {
        this._pickleKey = pickleKey;
        this._olm = olm;
        this._account = account;
        this._storage = storage;
        this._now = now;
        this._ownDeviceId = ownDeviceId;
    }

    discardOutboundSession(roomId, txn) {
        txn.outboundGroupSessions.remove(roomId);
    }

    async createRoomKeyMessage(roomId, txn) {
        let sessionEntry = await txn.outboundGroupSessions.get(roomId);
        if (sessionEntry) {
            const session = new this._olm.OutboundGroupSession();
            try {
                session.unpickle(this._pickleKey, sessionEntry.session);
                return this._createRoomKeyMessage(session, roomId);
            } finally {
                session.free();
            }
        }
    }

    /**
     * Encrypts a message with megolm
     * @param  {string} roomId           
     * @param  {string} type             event type to encrypt
     * @param  {string} content          content to encrypt
     * @param  {object} encryptionParams the content of the m.room.encryption event
     * @return {Promise<EncryptionResult>}
     */
    async encrypt(roomId, type, content, encryptionParams) {
        let session = new this._olm.OutboundGroupSession();
        try {
            const txn = this._storage.readWriteTxn([
                this._storage.storeNames.inboundGroupSessions,
                this._storage.storeNames.outboundGroupSessions,
            ]);
            let roomKeyMessage;
            let encryptedContent;
            try {
                // TODO: we could consider keeping the session in memory for the current room
                let sessionEntry = await txn.outboundGroupSessions.get(roomId);
                if (sessionEntry) {
                    session.unpickle(this._pickleKey, sessionEntry.session);
                }
                if (!sessionEntry || this._needsToRotate(session, sessionEntry.createdAt, encryptionParams)) {
                    // in the case of rotating, recreate a session as we already unpickled into it
                    if (sessionEntry) {
                        session.free();
                        session = new this._olm.OutboundGroupSession();
                    }
                    session.create();
                    roomKeyMessage = this._createRoomKeyMessage(session, roomId);
                    this._storeAsInboundSession(session, roomId, txn);
                    // TODO: we could tell the Decryption here that we have a new session so it can add it to its cache
                }
                encryptedContent = this._encryptContent(roomId, session, type, content);
                txn.outboundGroupSessions.set({
                    roomId,
                    session: session.pickle(this._pickleKey),
                    createdAt: sessionEntry?.createdAt || this._now(),
                });

            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            return new EncryptionResult(encryptedContent, roomKeyMessage);
        } finally {
            if (session) {
                session.free();
            }
        }
    }

    _needsToRotate(session, createdAt, encryptionParams) {
        let rotationPeriodMs = 604800000; // default
        if (Number.isSafeInteger(encryptionParams?.rotation_period_ms)) {
            rotationPeriodMs = encryptionParams?.rotation_period_ms;
        }
        let rotationPeriodMsgs = 100; // default
        if (Number.isSafeInteger(encryptionParams?.rotation_period_msgs)) {
            rotationPeriodMsgs = encryptionParams?.rotation_period_msgs;
        }

        if (this._now() > (createdAt + rotationPeriodMs)) {
            return true;
        }
        if (session.message_index() >= rotationPeriodMsgs) {
            return true;
        }  
    }

    _encryptContent(roomId, session, type, content) {
        const plaintext = JSON.stringify({
            room_id: roomId,
            type,
            content
        });
        const ciphertext = session.encrypt(plaintext);

        const encryptedContent = {
            algorithm: MEGOLM_ALGORITHM,
            sender_key: this._account.identityKeys.curve25519,
            ciphertext,
            session_id: session.session_id(),
            device_id: this._ownDeviceId
        };

        return encryptedContent;
    }

    _createRoomKeyMessage(session, roomId) {
        return {
            room_id: roomId,
            session_id: session.session_id(),
            session_key: session.session_key(),
            algorithm: MEGOLM_ALGORITHM,
            // chain_index is ignored by element-web if not all clients
            // but let's send it anyway, as element-web does so
            chain_index: session.message_index()
        }
    }

    _storeAsInboundSession(outboundSession, roomId, txn) {
        const {identityKeys} = this._account;
        const claimedKeys = {ed25519: identityKeys.ed25519};
        const session = new this._olm.InboundGroupSession();
        try {
            session.create(outboundSession.session_key());
            const sessionEntry = {
                roomId,
                senderKey: identityKeys.curve25519,
                sessionId: session.session_id(),
                session: session.pickle(this._pickleKey),
                claimedKeys,
            };
            txn.inboundGroupSessions.set(sessionEntry);
            return sessionEntry;
        } finally {
            session.free();
        }
    }
}

/**
 * @property {object?} roomKeyMessage  if encrypting this message
 *                                     created a new outbound session,
 *                                     this contains the content of the m.room_key message
 *                                     that should be sent out over olm.
 * @property {object} content  the encrypted message as the content of
 *                             the m.room.encrypted event that should be sent out   
 */
class EncryptionResult {
    constructor(content, roomKeyMessage) {
        this.content = content;
        this.roomKeyMessage = roomKeyMessage;
    }
}
