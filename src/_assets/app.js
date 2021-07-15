document.addEventListener('DOMContentLoaded', function () {
  const tray = document.querySelector('[data-tray]');
  if (!tray) {
    return;
  }

  tray.addEventListener('click', ({ target }) => {
    if (target.hasAttribute('data-tray')) {
      tray.classList.remove('expanded');
    }
  });

  document
    .querySelectorAll('[data-toggle-tray]')
    .forEach((element) =>
      element.addEventListener('click', () => tray.classList.toggle('expanded'))
    );
});
