// Development contract for the project-owned Style Lab fixture only.
const anchor = document.querySelector('#signal-button');
if (!anchor) throw new Error('Style Lab signal button is missing.');

const id = `ea-stylelab-script-button-${ea.id}`;
if (document.getElementById(id)) throw new Error('This extension instance already has a button.');
const button = document.createElement('button');
button.id = id;
button.type = 'button';
button.className = 'ea-stylelab-script-button';
button.textContent = 'Log a message';
button.dataset.clickCount = '0';
let clicks = 0;

const handleClick = () => {
  clicks += 1;
  button.dataset.clickCount = String(clicks);
  button.textContent = `Log a message (${clicks})`;
  console.log('Style Lab script button clicked', clicks);
};

// Register reversal before attaching listeners or inserting into the document.
ea.onDispose(() => {
  button.removeEventListener('click', handleClick);
  button.remove();
  console.info('Style Lab script button removed');
});
button.addEventListener('click', handleClick, { signal: ea.signal });
anchor.insertAdjacentElement('afterend', button);
console.info('Style Lab script button ready');
