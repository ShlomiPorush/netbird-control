// Apply the saved theme before first paint (avoids a flash). No override → follow the OS.
// Loaded as a blocking classic script in <head> so it runs before the body renders;
// kept as a separate file (not inline) so the Content-Security-Policy stays 'self'-only.
try {
    var t = localStorage.getItem('nb_theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    var dark = (t === 'dark') || (!t && (!window.matchMedia || !window.matchMedia('(prefers-color-scheme: light)').matches));
    document.documentElement.classList.toggle('dark', dark);
} catch (e) { }
