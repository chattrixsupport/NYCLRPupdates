# NYC Lake Roleplay website

## Run locally

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **OAuth2**, add this exact redirect URL: `http://localhost:3000/auth/discord/callback`.
3. Copy `.env.example` to `.env` and set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` from the application’s OAuth2 page. Keep the redirect URL as shown above for local development.
4. Run `npm start` and open `http://localhost:3000`.

The app requests only the Discord `identify` scope. It exchanges the authorization code on the server and fetches the signed-in profile from Discord’s `/users/@me` API. The client secret is never sent to the browser.

## Deploy on Bot-Hosting.net

1. Create a **Node.js** deployment and import this repository.
2. Set the startup command to:

   ```sh
   npm install && npm start
   ```

3. Add `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI` in the deployment's environment settings. Use your site's HTTPS URL followed by `/auth/discord/callback`, for example `https://your-site.apps.bot-hosting.cloud/auth/discord/callback`.
4. Add that exact HTTPS callback URL under **OAuth2 → Redirects** in the Discord Developer Portal.

The server listens on `0.0.0.0` and uses Bot-Hosting's `SERVER_PORT` environment variable. It also supports `PORT` as a fallback and defaults to `3000` for local development. Do not put the Discord client secret in website files or commit it to GitHub.

The app requests only the Discord `identify` scope. It exchanges the authorization code on the server and fetches the signed-in profile from Discord’s `/users/@me` API. The included session store is in memory, so users will need to sign in again after a server restart.
