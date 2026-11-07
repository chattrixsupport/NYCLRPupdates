const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer, getServerPort } = require("./server");

test("hosting port prefers SERVER_PORT and keeps local port fallbacks", () => {
  assert.equal(getServerPort({ SERVER_PORT: "4567", PORT: "3000" }), 4567);
  assert.equal(getServerPort({ PORT: "3000" }), 3000);
  assert.equal(getServerPort({}), 3000);
  assert.throws(() => getServerPort({ SERVER_PORT: "invalid" }), /SERVER_PORT or PORT/);
});

async function startTestServer(t, options = {}) {
  const environment = {
    DISCORD_CLIENT_ID: "test-client-id",
    DISCORD_CLIENT_SECRET: "test-client-secret",
    DISCORD_REDIRECT_URI: "",
  };
  const server = createServer({
    environment,
    fetchImpl: options.fetchImpl || fetch,
    logger: { error() {} },
    teamConfigPath: options.teamConfigPath,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  environment.DISCORD_REDIRECT_URI = `${origin}/auth/discord/callback`;
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  return { origin, environment };
}

test("development team loads Discord usernames and avatars from configured profile URLs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nyclrp-team-"));
  const teamConfigPath = path.join(directory, "team.json");
  await fs.writeFile(
    teamConfigPath,
    JSON.stringify({
      members: [
        {
          discordProfile: "https://discord.com/users/111111111111111111",
          role: "Project Lead",
        },
        {
          discordProfile: "https://discord.com/users/222222222222222222/",
          role: "Lead Developer",
        },
      ],
    }),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const apiCalls = [];
  const fetchImpl = async (url, options = {}) => {
    apiCalls.push({ url: String(url), options });
    const userId = String(url).split("/").pop();
    if (userId === "111111111111111111") {
      return Response.json({
        id: userId,
        username: "projectlead",
        global_name: "Project Lead",
        avatar: "a_animated_hash",
      });
    }
    if (userId === "222222222222222222") {
      return Response.json({
        id: userId,
        username: "developer",
        discriminator: "0",
        avatar: null,
      });
    }
    throw new Error(`Unexpected Discord API request: ${url}`);
  };
  const { origin, environment } = await startTestServer(t, {
    fetchImpl,
    teamConfigPath,
  });
  environment.DISCORD_BOT_TOKEN = "private-test-bot-token";

  const [teamResponse, homepageResponse] = await Promise.all([
    fetch(`${origin}/api/team`),
    fetch(origin),
  ]);
  const { members } = await teamResponse.json();

  assert.equal(teamResponse.status, 200);
  assert.deepEqual(members, [
    {
      name: "Project Lead",
      role: "Project Lead",
      avatar: "https://cdn.discordapp.com/avatars/111111111111111111/a_animated_hash.gif?size=128",
    },
    {
      name: "developer",
      role: "Lead Developer",
      avatar: "https://cdn.discordapp.com/embed/avatars/3.png",
    },
  ]);
  assert.equal(apiCalls.length, 2);
  assert.ok(
    apiCalls.every((call) => call.options.headers.Authorization === "Bot private-test-bot-token"),
  );

  const cachedResponse = await fetch(`${origin}/api/team`);
  assert.deepEqual(await cachedResponse.json(), { members });
  assert.equal(apiCalls.length, 2);

  assert.equal(homepageResponse.status, 200);
  const homepage = await homepageResponse.text();
  assert.match(homepage, /The NYCLRP Development Team/);
  assert.match(homepage, /href="#development-team">Development Team<\/a>/);
});

test("team API requires a bot token and valid Discord profile links", async (t) => {
  const { origin } = await startTestServer(t);

  const noTokenResponse = await fetch(`${origin}/api/team`);
  assert.equal(noTokenResponse.status, 503);
  assert.match((await noTokenResponse.json()).error, /DISCORD_BOT_TOKEN/);
});

test("Discord login exchanges the code, reads the profile, and creates a logout-able session", async (t) => {
  const apiCalls = [];
  const fetchImpl = async (url, options = {}) => {
    apiCalls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth2/token")) {
      return Response.json({ access_token: "test-access-token" });
    }
    if (String(url).endsWith("/users/@me")) {
      return Response.json({
        id: "123456789012345678",
        username: "testuser",
        global_name: "Test User",
        avatar: "avatar_hash",
      });
    }
    throw new Error(`Unexpected Discord API request: ${url}`);
  };
  const { origin, environment } = await startTestServer(t, { fetchImpl });

  const startResponse = await fetch(`${origin}/auth/discord`, { redirect: "manual" });
  assert.equal(startResponse.status, 302);
  const authorizationUrl = new URL(startResponse.headers.get("location"));
  const stateCookie = startResponse.headers.get("set-cookie").match(/nyclrp_oauth_state=([^;,]+)/)[1];
  assert.equal(authorizationUrl.origin, "https://discord.com");
  assert.equal(authorizationUrl.searchParams.get("client_id"), environment.DISCORD_CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get("scope"), "identify");
  assert.equal(authorizationUrl.searchParams.get("state"), stateCookie);

  const callbackUrl = new URL("/auth/discord/callback", origin);
  callbackUrl.searchParams.set("code", "test-authorization-code");
  callbackUrl.searchParams.set("state", stateCookie);
  const callbackResponse = await fetch(callbackUrl, {
    headers: { Cookie: `nyclrp_oauth_state=${stateCookie}` },
    redirect: "manual",
  });

  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get("location"), "/?login=success");
  const cookies = callbackResponse.headers.get("set-cookie");
  const sessionId = cookies.match(/nyclrp_session=([a-f0-9]+)/)[1];
  assert.match(cookies, /HttpOnly/);
  assert.match(cookies, /SameSite=Lax/);
  assert.equal(apiCalls.length, 2);

  const tokenRequest = apiCalls[0];
  assert.equal(tokenRequest.options.method, "POST");
  assert.equal(tokenRequest.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  const tokenBody = new URLSearchParams(tokenRequest.options.body);
  assert.equal(tokenBody.get("client_secret"), environment.DISCORD_CLIENT_SECRET);
  assert.equal(tokenBody.get("code"), "test-authorization-code");
  assert.equal(tokenBody.get("redirect_uri"), environment.DISCORD_REDIRECT_URI);
  assert.equal(apiCalls[1].options.headers.Authorization, "Bearer test-access-token");

  const profileResponse = await fetch(`${origin}/api/me`, {
    headers: { Cookie: `nyclrp_session=${sessionId}` },
  });
  assert.equal(profileResponse.status, 200);
  assert.deepEqual((await profileResponse.json()).user, {
    id: "123456789012345678",
    username: "testuser",
    displayName: "Test User",
    avatarUrl: "https://cdn.discordapp.com/avatars/123456789012345678/avatar_hash.png?size=64",
  });

  const invalidLogoutResponse = await fetch(`${origin}/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: `nyclrp_session=${sessionId}`,
      Origin: "https://untrusted.example",
    },
  });
  assert.equal(invalidLogoutResponse.status, 403);

  const logoutResponse = await fetch(`${origin}/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: `nyclrp_session=${sessionId}`,
      Origin: origin,
    },
  });
  assert.equal(logoutResponse.status, 200);
  assert.deepEqual(await logoutResponse.json(), { ok: true });

  const loggedOutResponse = await fetch(`${origin}/api/me`, {
    headers: { Cookie: `nyclrp_session=${sessionId}` },
  });
  assert.deepEqual(await loggedOutResponse.json(), { user: null });
});

test("Discord callback rejects a mismatched OAuth state without calling Discord", async (t) => {
  let apiCalls = 0;
  const { origin } = await startTestServer(t, {
    fetchImpl: async () => {
      apiCalls += 1;
      return Response.json({});
    },
  });

  const response = await fetch(
    `${origin}/auth/discord/callback?code=unused&state=incorrect`,
    {
      headers: { Cookie: "nyclrp_oauth_state=expected" },
      redirect: "manual",
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/?login=failed");
  assert.equal(apiCalls, 0);
});

test("Discord login reports an unconfigured server instead of starting OAuth", async (t) => {
  const server = createServer({
    environment: {},
    logger: { error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const homepageResponse = await fetch(origin);
  assert.equal(homepageResponse.status, 200);
  assert.match(await homepageResponse.text(), /data-login-link href="\/auth\/discord"/);

  const response = await fetch(`${origin}/auth/discord`);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /not configured/);
});
