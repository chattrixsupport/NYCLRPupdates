const menuToggle = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
const loginLinks = document.querySelectorAll("[data-login-link]");
const logoutButtons = document.querySelectorAll("[data-logout]");
const memberStatus = document.querySelector("[data-member-status]");
const authStatus = document.querySelector("[data-auth-status]");

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

  if (memberStatus) {
    memberStatus.textContent = user ? `Signed in as ${user.displayName || user.username}` : "";
    memberStatus.hidden = !user;
  }
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
