# Updates

BluePhoenix checks for a newer version each time it starts (turn this off in **Settings → Updates**). When one is available, a green **Update x.y.z** button appears in the top bar.

## Install an update

1. Click the update button, or open **Settings → Updates** and press **Check for updates**.
2. Press **Download update**. A progress bar shows the download. The installer is saved in your **Downloads** folder.
3. Press **Open installer**, and follow it (on Mac, drag the new BluePhoenix into **Applications** and replace the old one). Press **Quit BluePhoenix** first if the installer asks you to close the app.

Your projects and settings are kept. They are stored separately from the app.

If **No installer has been published for this platform yet** appears, a new version exists but not for your system. Try again later.

## Verified updates

BluePhoenix downloads updates over HTTPS only, and checks every installer before it can be opened: its SHA-256 checksum and its digital signature must match what the release published, signed with the BluePhoenix release key built into the app. If either check fails, the download is deleted and you see **The update failed verification**. Nothing is installed. Try again later, or download the new version from the website.

**This update has no checksum or signature** means the release was published without them. BluePhoenix won't install it; download it manually instead.

## Signing a release (maintainers)

Installers are signed with [minisign](https://jedisct1.github.io/minisign/) (`brew install minisign`).

**Once:** create the release key. Keep the secret key (and its password) private and backed up; commit only the public key, which is built into the app.

```bash
minisign -G -f -p src-tauri/keys/update.pub -s ~/.minisign/bluephoenix.key
```

A build whose `src-tauri/keys/update.pub` is still the placeholder can't verify, so it refuses every update. Changing the key later means older installs refuse the new releases, so don't lose it.

**Each release**, for every platform's installer, after uploading it:

```bash
scripts/sign-update.sh path/to/BluePhoenix_x.y.z.dmg macos https://…/BluePhoenix_x.y.z.dmg
```

The script asks for the key password, writes `BluePhoenix_x.y.z.dmg.minisig`, checks it against `src-tauri/keys/update.pub`, and prints the entry to paste into `bluephoenix-d.json`:

```json
{
  "macos": { "url": "https://…/BluePhoenix_x.y.z.dmg", "sha256": "…", "signature": "…" }
}
```

`signature` is the `.minisig` file base64-encoded on one line. Use `-k` or `BLUEPHOENIX_SIGNING_KEY` if the secret key lives elsewhere. Versions 0.2.2 and older only read a plain URL per platform (`"macos": "https://…"`); to keep offering them the update, use the flat form the script also prints (`"macos"`, `"macos_sha256"`, `"macos_signature"`), which newer versions read too. Update `bluephoenix-v.json` last, once the installers and `bluephoenix-d.json` are in place.
