document.addEventListener("DOMContentLoaded", () => {
  const sticky = document.querySelector(".sticky-mobile");
  const heroCta = document.querySelector(".hero .button-primary");
  if (!sticky || !heroCta) return;

  const setVisible = (visible) => {
    sticky.classList.toggle("is-visible", visible);
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(!entry.isIntersecting);
    }, { threshold: 0.15 });
    observer.observe(heroCta);
  } else {
    const update = () => {
      setVisible(heroCta.getBoundingClientRect().bottom < 0);
    };
    window.addEventListener("scroll", update, { passive: true });
    update();
  }
});
