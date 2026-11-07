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
    teamAvatarsPath: options.teamAvatarsPath,
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

test("team avatars update when the matching Discord users log in and survive restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nyclrp-team-"));
  const teamAvatarsPath = path.join(directory, "team-avatars.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const profiles = new Map([
    ["brage-login", {
      id: "1272842004073807916",
      username: "brage",
      global_name: "Brage",
      avatar: "a_brage_avatar",
    }],
    ["ishaa-login", {
      id: "963116153616605215",
      username: "ishaa",
      global_name: "Ishaa",
      avatar: "ishaa_avatar",
    }],
    ["other-login", {
      id: "123456789012345678",
      username: "other",
      global_name: "Other",
      avatar: "other_avatar",
    }],
  ]);
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/oauth2/token")) {
      const code = new URLSearchParams(options.body).get("code");
      return Response.json({ access_token: code });
    }
    if (String(url).endsWith("/users/@me")) {
      const token = options.headers.Authorization.replace("Bearer ", "");
      return Response.json(profiles.get(token));
    }
    throw new Error(`Unexpected Discord API request: ${url}`);
  };
  const options = { fetchImpl, teamAvatarsPath };
  const { origin } = await startTestServer(t, options);

  async function signIn(code) {
    const startResponse = await fetch(`${origin}/auth/discord`, { redirect: "manual" });
    const state = new URL(startResponse.headers.get("location")).searchParams.get("state");
    const stateCookie = startResponse.headers.get("set-cookie").match(/nyclrp_oauth_state=([^;,]+)/)[1];
    const callbackUrl = new URL("/auth/discord/callback", origin);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", state);
    const callbackResponse = await fetch(callbackUrl, {
      headers: { Cookie: `nyclrp_oauth_state=${stateCookie}` },
      redirect: "manual",
    });
    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get("location"), "/?login=success");
  }

  const initialResponse = await fetch(`${origin}/api/team`);
  assert.equal(initialResponse.status, 200);
  const initialTeam = await initialResponse.json();
  assert.deepEqual(initialTeam.members.map(({ name, role, avatar }) => ({ name, role, avatar })), [
    {
      name: "Ishaaniuniek",
      role: "Head of Server Development",
      avatar: "/default-avatar.svg",
    },
    { name: "Brage", role: "Senior Developer", avatar: "/default-avatar.svg" },
  ]);

  await signIn("brage-login");
  let team = await (await fetch(`${origin}/api/team`)).json();
  assert.equal(
    team.members[1].avatar,
    "https://cdn.discordapp.com/avatars/1272842004073807916/a_brage_avatar.gif?size=128",
  );
  assert.equal(team.members[0].avatar, "/default-avatar.svg");

  await signIn("other-login");
  team = await (await fetch(`${origin}/api/team`)).json();
  assert.equal(team.members[1].avatar.includes("a_brage_avatar.gif"), true);
  assert.equal(team.members[0].avatar, "/default-avatar.svg");

  await signIn("ishaa-login");
  team = await (await fetch(`${origin}/api/team`)).json();
  assert.equal(
    team.members[0].avatar,
    "https://cdn.discordapp.com/avatars/963116153616605215/ishaa_avatar.png?size=128",
  );
  assert.equal(team.members[1].avatar.includes("a_brage_avatar.gif"), true);

  const privateCacheResponse = await fetch(`${origin}/team-avatars.json`);
  assert.equal(privateCacheResponse.status, 404);

  const restartedServer = await startTestServer(t, options);
  const persistedTeam = await (await fetch(`${restartedServer.origin}/api/team`)).json();
  assert.deepEqual(persistedTeam, { members: team.members });

  const homepage = await (await fetch(`${restartedServer.origin}/`)).text();
  assert.doesNotMatch(homepage, /data-team-grid|Community links and updates|Ways to Roleplay/);
  const pages = [
    ["roleplay.html", /Ways to Roleplay/, /href="roleplay\.html" aria-current="page">Roleplay<\/a>/],
    ["development-team.html", /The NYCLRP Development Team/, /href="development-team\.html" aria-current="page">Development Team<\/a>/],
    ["community.html", /class="card-label">COMMUNITY/, /href="community\.html" aria-current="page">Community<\/a>/],
  ];
  for (const [fileName, pageContent, activeNavigation] of pages) {
    const pageResponse = await fetch(`${restartedServer.origin}/${fileName}`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, pageContent);
    assert.match(page, activeNavigation);
    for (const [otherFile] of pages) {
      if (otherFile !== fileName) {
        assert.match(page, new RegExp(`href="${otherFile}"`));
      }
    }
  }
  const communityPage = await (await fetch(`${restartedServer.origin}/community.html`)).text();
  assert.match(communityPage, /<span>Join Discord!<\/span>/);
  assert.match(communityPage, /href="https:\/\/discord\.gg\/nyclrp"/);

  const teamPage = await (await fetch(`${restartedServer.origin}/development-team.html`)).text();
  assert.doesNotMatch(teamPage, /Community links and updates|Ways to Roleplay/);
  const roleplayPage = await (await fetch(`${restartedServer.origin}/roleplay.html`)).text();
  for (const section of ["Make a character", "Start a scene", "Keep it realistic", "Build the story together"]) {
    assert.match(roleplayPage, new RegExp(`<h2>${section}<\\/h2>`));
  }
  assert.doesNotMatch(roleplayPage, /role-card|Play ER:LC|https:\/\/erlc\.gg\/join\/nyclrp/);
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
    avatarUrl: "https://cdn.discordapp.com/avatars/123456789012345678/avatar_hash.png?size=128",
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
