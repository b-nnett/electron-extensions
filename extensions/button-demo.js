// This file lives OUTSIDE the signed fixture and executes only in its renderer.
(() => {
  const id = 'extensions-anywhere-demo-button';
  const existing = document.getElementById(id);
  if (existing) return { present: true, clickCount: Number(existing.dataset.clickCount) || 0 };

  const anchor = document.querySelector('#signal-button');
  if (!anchor) throw new Error('Style Lab button anchor is missing.');

  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.textContent = 'Log a message';
  button.dataset.clickCount = '0';
  let clicks = 0;
  button.addEventListener('click', () => {
    clicks += 1;
    button.dataset.clickCount = String(clicks);
    button.textContent = `Log a message (${clicks})`;
    console.log('[Extensions Anywhere] Button clicked', clicks);
  });
  anchor.insertAdjacentElement('afterend', button);
  return { present: true, clickCount: 0 };
})();
