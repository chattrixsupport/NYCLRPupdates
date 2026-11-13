const DASHBOARD_ROLE_ID = "1543352116104401016";

const menuToggle = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
const loginLinks = document.querySelectorAll("[data-login-link]");
const logoutButtons = document.querySelectorAll("[data-logout]");
const dashboardLink = document.querySelector("[data-dashboard-link]");
const memberStatus = document.querySelector("[data-member-status]");
const communityMembers = document.querySelector("[data-community-members]");
const communityOnline = document.querySelector("[data-community-online]");
const communityStats = document.querySelector(".community-stats");
const communityStatsStatus = document.querySelector("[data-community-stats-status]");
const communityMemberStatus = document.querySelector("[data-community-member-status]");
const communityMemberProfile = document.querySelector("[data-community-member-profile]");
const communityMemberAvatar = document.querySelector("[data-community-member-avatar]");
const communityMemberName = document.querySelector("[data-community-member-name]");
const authStatus = document.querySelector("[data-auth-status]");
const teamGrid = document.querySelector("[data-team-grid]");
const teamStatus = document.querySelector("[data-team-status]");

function showAuthStatus(message, kind) {
  if (!authStatus) {
    return;
  }

  authStatus.textContent = message;
  authStatus.dataset.kind = kind;
  authStatus.hidden = false;
}

function setSignedInUser(user) {
  loginLinks.forEach((link) => {
    link.hidden = Boolean(user);
  });
  logoutButtons.forEach((button) => {
    button.hidden = !user;
  });

  if (dashboardLink) {
    const hasRole = user && user.roles && user.roles.includes(DASHBOARD_ROLE_ID);
    dashboardLink.hidden = !hasRole;
  }

  if (memberStatus) {
    memberStatus.textContent = user ? `Signed in as ${user.displayName || user.username}` : "";
    memberStatus.hidden = !user;
  }

  if (communityMemberStatus) {
    if (!user) {
      communityMemberStatus.textContent =
        "Log in with Discord to check whether your account is in the server.";
      communityMemberProfile.hidden = true;
      return;
    }

    if (user.isCommunityMember === true) {
      communityMemberStatus.textContent = "Your Discord account is a member of NYCLRP.";
      communityMemberName.textContent = user.displayName || user.username;
      communityMemberAvatar.src = user.avatarUrl;
      communityMemberProfile.hidden = false;
    } else if (user.isCommunityMember === false) {
      communityMemberStatus.textContent =
        "This Discord account is not in the server yet. Join above, then sign in again.";
      communityMemberProfile.hidden = true;
    } else {
      communityMemberStatus.textContent = "Could not verify this account’s server membership.";
      communityMemberProfile.hidden = true;
    }
  }
}

if (communityMemberAvatar) {
  communityMemberAvatar.addEventListener("error", () => {
    communityMemberAvatar.src = "/default-avatar.svg";
  });
}

if (communityMembers && communityOnline && communityStats && communityStatsStatus) {
  fetch("/api/community", { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) {
        return response.json().then(({ error }) => {
          throw new Error(error || `Community stats request failed with status ${response.status}.`);
        });
      }
      return response.json();
    })
    .then((stats) => {
      if (
        !stats ||
        typeof stats.name !== "string" ||
        !Number.isSafeInteger(stats.memberCount) ||
        !Number.isSafeInteger(stats.onlineCount)
      ) {
        throw new Error("Community stats response is invalid.");
      }
      communityMembers.textContent = stats.memberCount.toLocaleString();
      communityOnline.textContent = stats.onlineCount.toLocaleString();
      communityStatsStatus.textContent = `${stats.name} · Counts are approximate`;
      communityStats.setAttribute("aria-busy", "false");
    })
    .catch((error) => {
      console.error("Could not load Discord community stats:", error);
      communityStatsStatus.textContent = "Server stats are unavailable right now.";
      communityStats.setAttribute("aria-busy", "false");
    });
}

function renderTeam(members) {
  if (!Array.isArray(members) || members.length !== 2) {
    throw new Error("The development team must contain exactly two members.");
  }

  const cards = members.map((member) => {
    if (
      !member ||
      typeof member.name !== "string" ||
      !member.name.trim() ||
      typeof member.role !== "string" ||
      !member.role.trim() ||
      typeof member.avatar !== "string" ||
      !member.avatar.trim()
    ) {
      throw new Error("Each team member needs a name, role, and avatar.");
    }

    const card = document.createElement("article");
    card.className = "team-card";

    const avatar = document.createElement("img");
    avatar.className = "team-avatar";
    avatar.src = member.avatar;
    avatar.alt = `${member.name.trim()} profile`;
    avatar.width = 94;
    avatar.height = 94;
    avatar.addEventListener("error", () => {
      avatar.src = "/default-avatar.svg";
    }, { once: true });

    const name = document.createElement("h3");
    name.className = "team-name";
    name.textContent = member.name.trim();

    const role = document.createElement("p");
    role.className = "team-role";
    role.textContent = member.role.trim();

    card.append(avatar, name, role);
    return card;
  });

  teamGrid?.replaceChildren(...cards);
  if (teamStatus) {
    teamStatus.hidden = true;
  }
}

if (teamGrid && teamStatus) {
  fetch("/api/team", { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) {
        return response.json().then(({ error }) => {
          throw new Error(error || `Team data request failed with status ${response.status}.`);
        });
      }
      return response.json();
    })
    .then((data) => renderTeam(data.members))
    .catch((error) => {
      console.error("Could not load the development team:", error);
      teamStatus.textContent = error.message || "Could not load the development team.";
    });
}

menuToggle?.addEventListener("click", function () {
  const isExpanded = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isExpanded));
  mainNav?.classList.toggle("is-open", !isExpanded);
});

mainNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    menuToggle?.setAttribute("aria-expanded", "false");
    mainNav?.classList.remove("is-open");
  });
});

logoutButtons.forEach((button) => {
  button.addEventListener("click", () => {
    fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Logout request failed");
        }
        setSignedInUser(null);
        showAuthStatus("You have been logged out.", "success");
      })
      .catch(() => {
        showAuthStatus("Could not log out. Please try again.", "error");
      });
  });
});

fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
  .then((response) => {
    if (!response.ok) {
      throw new Error("Could not check the sign-in status");
    }
    return response.json();
  })
  .then(({ user }) => {
    setSignedInUser(user);
  })
  .catch(() => {
    showAuthStatus("Could not check your Discord sign-in status.", "error");
  });

const loginResult = new URLSearchParams(window.location.search).get("login");
if (loginResult === "success") {
  showAuthStatus("You are signed in with Discord.", "success");
} else if (loginResult === "cancelled") {
  showAuthStatus("Discord sign-in was cancelled.", "error");
} else if (loginResult === "failed") {
  showAuthStatus("Discord sign-in failed. Please try again.", "error");
}

if (loginResult) {
  window.history.replaceState({}, "", window.location.pathname + window.location.hash);
}
