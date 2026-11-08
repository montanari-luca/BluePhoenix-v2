Test-only minisign keypair used by the updater unit tests (`src/updater.rs`).

`test.key` is unencrypted and public on purpose. It must never sign a release; the app trusts only `src-tauri/keys/update.pub`.

- `payload.bin` is signed with `test.key` (`payload.bin.minisig`).
- `other.pub` is an unrelated key, for the "wrong key" test.
