import Hls from 'hls.js';

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('cover-video');
  const videoId = video?.dataset?.videoId;

  if (videoId) {
    let hlsVideo = new Hls();
    hlsVideo.loadSource(
      `https://videodelivery.net/${videoId}/manifest/video.m3u8`
    );
    hlsVideo.attachMedia(video);
  }
});

document.addEventListener('DOMContentLoaded', () => {
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
