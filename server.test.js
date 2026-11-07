const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { createServer, getServerPort } = require("./server");

test("hosting port prefers SERVER_PORT and keeps local port fallbacks", () => {
  assert.equal(getServerPort({ SERVER_PORT: "4567", PORT: "3000" }), 4567);
  assert.equal(getServerPort({ PORT: "3000" }), 3000);
  assert.equal(getServerPort({}), 3000);
  assert.throws(() => getServerPort({ SERVER_PORT: "invalid" }), /SERVER_PORT or PORT/);
});

test("development team data includes two role-tagged profiles and a local avatar", async (t) => {
  const { origin } = await startTestServer(t);
  const [teamResponse, avatarResponse, homepageResponse] = await Promise.all([
    fetch(`${origin}/team.json`),
    fetch(`${origin}/default-avatar.svg`),
    fetch(origin),
  ]);
  const { members } = await teamResponse.json();

  assert.equal(teamResponse.status, 200);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map(({ role }) => role), ["Project Lead", "Lead Developer"]);
  assert.ok(members.every(({ name, avatar }) => name && avatar === "/default-avatar.svg"));
  assert.equal(avatarResponse.status, 200);
  assert.match(avatarResponse.headers.get("content-type"), /image\/svg\+xml/);
  assert.equal(homepageResponse.status, 200);
  const homepage = await homepageResponse.text();
  assert.match(homepage, /The NYCLRP Development Team/);
  assert.match(homepage, /href="#development-team">Development Team<\/a>/);
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
