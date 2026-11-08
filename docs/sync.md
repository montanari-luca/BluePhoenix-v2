# Cloud sync and the iPhone app

Cloud sync keeps your **projects, to-dos, notes, commands and time entries** the same on every computer and on your iPhone. It uses a PostgreSQL database that **you** own, so nobody else ever sees your data. [Neon](https://neon.tech) is the default because it has a free plan, but any PostgreSQL 12+ database works (Supabase, Railway, your own server).

What syncs: project names, descriptions, types, favourites, links, to-dos, notes, commands and time. What stays on each computer: folder locations, your editor and terminal choices, files and git state. A project that arrives from another computer shows as *No folder* until you pick its folder with **Edit project…**.

## Set up Neon (about two minutes)

1. Sign in at [neon.tech](https://neon.tech) and create a project.
2. On the project dashboard open **Connect** and copy the connection string (the direct and the pooled one both work).
3. Keep the whole string, including `?sslmode=require`. It looks like `postgresql://user:password@ep-something.region.aws.neon.tech/neondb?sslmode=require`.

## Connect the desktop app

1. Open **Settings → Cloud sync**.
2. Choose **Neon (default)** or **Other Postgres**, and paste the connection string.
3. Press **Test connection**, then **Connect & sync**.

BluePhoenix creates its own tables (names start with `bp_`) and uploads what you have. From then on it syncs every minute, and **Sync now** does it immediately. Repeat on your other computers with the **same** connection string.

The connection string contains your password, so it is stored in your system keychain, not in BluePhoenix's data file.

**Disconnect** stops syncing and keeps your local data. Data already in the database stays there.

## The iPhone app

Install BluePhoenix on your iPhone, open **Settings**, paste the same connection string, and press **Connect & sync**.

- Pull down on the project list to sync. It also syncs when you open the app and a moment after each change.
- You can add projects, tick off and edit to-dos, edit notes, and log time on the go. Everything works offline and syncs when you are back online.
- Commands are shown for reference (long-press to copy). They run on your computer.
- The **Git** tab shows the branch, whether there is something to push, pull or commit, and the last 10 commits, as shared by the computer that has the project's folder. It is read-only and appears once that computer has synced.
- Swipe a project left to **Archive** it; archived projects are under **Archived** at the bottom of the list.
- To use another database, **Disconnect** and connect again.

## How conflicts are handled

If you change the same item on two devices before they sync, the **most recent change wins**. Deleting an item on one device removes it everywhere.

When an edit you made on this computer loses to a newer one from another device, BluePhoenix keeps your version. **Settings → Sync conflicts** (shown only when there are some) lists each one with what changed, and you can **Restore mine** (it becomes the newest edit and syncs everywhere) or **Keep the newer one**.

**What syncs:** projects (including archived state), to-dos, pages, notes, commands, time, fork upstream settings, and a short git summary for the iPhone. **What stays on each computer:** folder paths, automations, fork check results, the file index and your keys.

## Troubleshooting

- **"Last attempt failed"**: the message says why. Typical causes are a wrong password, an expired Neon branch, or no internet.
- **Authentication errors**: copy the connection string again from Neon; passwords can be reset there.
- **Something looks missing on one device**: press **Sync now** on both devices. Clocks that are minutes apart can reorder very close edits, so keep automatic date and time on.
