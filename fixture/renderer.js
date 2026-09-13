let pings = 0;
document.querySelector('#signal-button').addEventListener('click', () => {
  pings += 1;
  document.querySelector('#receipt').textContent = `${pings} ${pings === 1 ? 'ping' : 'pings'} sent. Looking good.`;
});
