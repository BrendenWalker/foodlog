# Calorie Tracker

A small calorie tracker you can install on an iPhone. It works offline and keeps your foods and history on the phone. No account.

**[Install Calorie Tracker](https://brendenwalker.github.io/foodlog/)**

## Add to your Home Screen

1. Open the link above in **Safari**.
2. Tap the Share button.
3. Tap **Add to Home Screen**.
4. Open **Calories** from your Home Screen.

After that first open, tracking works without a network connection.

## On this phone

Foods, meals, and the daily calorie target stay in this browser. Use **Settings → Export Data** to save a backup, and **Import Data** to restore one.

## Optional sync server

The PWA stores data on-device by default. Settings → Sync can point at a small Docker API that keeps a central copy in Postgres (or SQLite) so desktop and phone stay aligned, including offline queues.

```
cd server
export FOODLOG_SYNC_SECRET='oats-42'
docker compose up --build -d
```

Set the PWA server URL to your HTTPS endpoint and the same shared secret. Semver tags publish both the Pages site and `ghcr.io/brendenwalker/foodlog-sync` (`latest` plus the version, e.g. `1.8.0`). PRs that touch `server/` only test-build the image. For Swarm, pull that image and point `DATABASE_URL` at your Postgres; see `server/docker-stack.example.yml`.

## Publish

The app is the `docs/` folder. The README stays in the repository and is not part of the site.

A semver tag publishes the site. Pushes to `main` do not.

Once, in the repository settings, open **Pages → Build and deployment** and set **Source** to **GitHub Actions**. While Source is still "Deploy from a branch", pushes to `main` keep publishing.

```
git tag v1.2.3
git push origin v1.2.3
```

Prerelease tags such as `v1.2.3-rc.1` publish too. The header shows the tag.
