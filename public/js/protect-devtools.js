// Blokir klik kanan (context menu)
document.addEventListener('contextmenu', function (e) {
  e.preventDefault();
}, { capture: true });

// Cegah beberapa shortcut DevTools dasar
document.addEventListener('keydown', function (e) {
  // F12
  if (e.key === 'F12') {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C
  if (e.ctrlKey && e.shiftKey) {
    var k = e.key.toUpperCase();
    if (k === 'I' || k === 'J' || k === 'C') {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }

  // Ctrl+U (View Source)
  if (e.ctrlKey && e.key.toUpperCase() === 'U') {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
}, { capture: true });