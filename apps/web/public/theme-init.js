// Applies the saved theme before first paint so there is no flash.
try {
  var t = localStorage.getItem('opensheet-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
