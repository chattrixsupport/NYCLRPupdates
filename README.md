# NYC Lake Roleplay website

## Run locally

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **OAuth2**, add this exact redirect URL: `http://localhost:3000/auth/discord/callback`.
3. Copy `.env.example` to `.env` and set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` from the application’s OAuth2 page. Keep the redirect URL as shown above for local development.
4. Run `npm start` and open `http://localhost:3000`.

The app requests only the Discord `identify` scope. It exchanges the authorization code on the server and fetches the signed-in profile from Discord’s `/users/@me` API. The client secret is never sent to the browser.

For deployment, set the same environment variables on the server, use an HTTPS `DISCORD_REDIRECT_URI`, and register that exact URL in the Discord Developer Portal. The callback path must remain `/auth/discord/callback`. The included session store is in memory, so users will need to sign in again after a server restart.
