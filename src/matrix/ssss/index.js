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

import {KeyDescription, Key} from "./common.js";
import {keyFromPassphrase} from "./passphrase.js";
import {keyFromRecoveryKey} from "./recoveryKey.js";

async function readDefaultKeyDescription(storage) {
    const txn = storage.readTxn([
        storage.storeNames.accountData
    ]);
    const defaultKeyEvent = await txn.accountData.get("m.secret_storage.default_key");
    const id = defaultKeyEvent?.content?.key;
    if (!id) {
        return;
    }
    const keyAccountData = await txn.accountData.get(`m.secret_storage.key.${id}`);
    if (!keyAccountData) {
        return;
    }
    return new KeyDescription(id, keyAccountData);
}

export async function writeKey(key, txn) {
    txn.session.set("ssssKey", {id: key.id, binaryKey: key.binaryKey});
}

export async function readKey(txn) {
    const keyData = await txn.session.get("ssssKey");
    if (!keyData) {
        return;
    }
    const keyAccountData = await txn.accountData.get(`m.secret_storage.key.${keyData.id}`);
    return new Key(new KeyDescription(keyData.id, keyAccountData), keyData.binaryKey);
}

export async function keyFromCredential(type, credential, storage, cryptoDriver, olm) {
    const keyDescription = await readDefaultKeyDescription(storage);
    if (!keyDescription) {
        throw new Error("Could not find a default secret storage key in account data");
    }
    let key;
    if (type === "passphrase") {
        key = await keyFromPassphrase(keyDescription, credential, cryptoDriver);
    } else if (type === "recoverykey") {
        key = keyFromRecoveryKey(olm, keyDescription, credential);
    } else {
        throw new Error(`Invalid type: ${type}`);
    }
    return key;
}
