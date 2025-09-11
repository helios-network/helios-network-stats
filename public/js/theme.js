import * as el from './elements.js';

function updateThemeIcon(theme) {
  if (!el.themeIcon) return;
  if (theme === 'light') {
    el.themeIcon.className = 'fas fa-moon';
  } else {
    el.themeIcon.className = 'fas fa-sun';
  }
}

export function initTheme() {
  try {
    const savedTheme = localStorage.getItem('helios:theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
    updateThemeIcon('dark');
  }
}

export function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  document.documentElement.setAttribute('data-theme', newTheme);
  updateThemeIcon(newTheme);

  try {
    localStorage.setItem('helios:theme', newTheme);
  } catch {}
}

