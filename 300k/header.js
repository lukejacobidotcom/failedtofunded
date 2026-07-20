(function () {
  "use strict";

  const menuButtons = Array.from(document.querySelectorAll(".nav-menu-button"));
  const mobileToggle = document.getElementById("mobileMenuToggle");
  const mobileMenu = document.getElementById("mobileMenu");

  function closeDesktopMenus(except) {
    menuButtons.forEach((button) => {
      if (button !== except) button.setAttribute("aria-expanded", "false");
    });
  }

  menuButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = button.getAttribute("aria-expanded") !== "true";
      closeDesktopMenus(button);
      button.setAttribute("aria-expanded", String(opening));
    });
  });

  document.addEventListener("click", () => closeDesktopMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDesktopMenus();
      if (mobileToggle && mobileMenu) {
        mobileToggle.setAttribute("aria-expanded", "false");
        mobileMenu.classList.remove("is-open");
      }
    }
  });

  if (mobileToggle && mobileMenu) {
    mobileToggle.addEventListener("click", () => {
      const opening = mobileToggle.getAttribute("aria-expanded") !== "true";
      mobileToggle.setAttribute("aria-expanded", String(opening));
      mobileMenu.classList.toggle("is-open", opening);
    });
  }
}());
