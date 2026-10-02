/**
 * Options - Extension settings and preferences UI
 * 
 * Purpose: Provides user interface for configuring extension behavior and preferences
 * Key Functions: Auto-archive settings, extension preferences management
 * Architecture: Options page that syncs with chrome.storage for persistent settings
 * 
 * Critical Notes:
 * - Settings are synced across devices via chrome.storage.sync
 * - Auto-archive timing affects background script alarm configuration
 * - Changes trigger background script updates via message passing
 * - Provides real-time feedback for setting changes
 */

import { Utils } from './utils.js';
import { Logger } from './logger.js';

const DEFAULT_SIDEBAR_SURFACE_COLOR = '#fff8f6';

// Helper to safely get checkbox value with default
function getCheckboxValue(element, defaultValue) {
  return element ? element.checked : defaultValue;
}

// Helper to safely set checkbox value with default
function setCheckboxValue(element, value, defaultValue) {
  if (element) {
    element.checked = value !== undefined ? value : defaultValue;
  }
}

// Helper to add event listener if element exists
function addListenerIfExists(elementId, event, handler) {
  const element = document.getElementById(elementId);
  if (element) {
    element.addEventListener(event, handler);
  }
  return element;
}

function updateAutoArchiveIdleMinutesVisibility(forceEnabled) {
  const container = document.getElementById('autoArchiveIdleMinutesContainer');
  const checkbox = document.getElementById('autoArchiveEnabled');
  const input = document.getElementById('autoArchiveIdleMinutes');
  if (!container || !checkbox || !input) return;

  const isEnabled = forceEnabled !== undefined ? Boolean(forceEnabled) : Boolean(checkbox.checked);
  container.style.display = isEnabled ? '' : 'none';
  input.disabled = !isEnabled;
}

// Function to save options to chrome.storage
async function saveOptions() {
  const autoArchiveIdleMinutesInput = document.getElementById('autoArchiveIdleMinutes');

  const settings = {
    autoArchiveEnabled: getCheckboxValue(document.getElementById('autoArchiveEnabled'), false),
    autoArchiveIdleMinutes: parseInt(autoArchiveIdleMinutesInput?.value, 10) || 360,
    enableSpotlight: getCheckboxValue(document.getElementById('enableSpotlight'), true),
    enableSearchSuggestions: getCheckboxValue(document.getElementById('enableSearchSuggestions'), true),
    showAllOpenTabsInCollapsedFolders: getCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), false),
    sidebarSurfaceColor:
      document.getElementById('sidebarSurfaceColor')?.value ||
      DEFAULT_SIDEBAR_SURFACE_COLOR,
    newTabPosition:
      document.getElementById('newTabPosition')?.value === 'top' ? 'top' : 'bottom',
    debugLoggingEnabled: getCheckboxValue(document.getElementById('debugLoggingEnabled'), false)
  };

  try {
    await chrome.storage.sync.set(settings);
    Logger.log('Settings saved:', settings);

    await chrome.runtime.sendMessage({ action: 'updateAutoArchiveSettings' });
    showToast();
  } catch (error) {
    Logger.error('Error saving settings:', error);
  }
}

// Function to show toast notification
function showToast() {
  const toast = document.getElementById('saveToast');
  if (!toast) return;

  // Add show class to trigger animation
  toast.classList.add('show');

  // Remove show class after 2 seconds
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

// Function to restore options from chrome.storage
async function restoreOptions() {
  const settings = await Utils.getSettings();

  // Restore checkbox values
  setCheckboxValue(document.getElementById('autoArchiveEnabled'), settings.autoArchiveEnabled, false);
  setCheckboxValue(document.getElementById('enableSpotlight'), settings.enableSpotlight, true);
  setCheckboxValue(document.getElementById('enableSearchSuggestions'), settings.enableSearchSuggestions, true);
  setCheckboxValue(document.getElementById('showAllOpenTabsInCollapsedFolders'), settings.showAllOpenTabsInCollapsedFolders, false);
  setCheckboxValue(document.getElementById('debugLoggingEnabled'), settings.debugLoggingEnabled, false);

  // Restore number input
  const autoArchiveIdleMinutesInput = document.getElementById('autoArchiveIdleMinutes');
  if (autoArchiveIdleMinutesInput) {
    autoArchiveIdleMinutesInput.value = settings.autoArchiveIdleMinutes;
  }
  updateAutoArchiveIdleMinutesVisibility(settings.autoArchiveEnabled);

  const sidebarSurfaceColor = document.getElementById('sidebarSurfaceColor');
  if (sidebarSurfaceColor) {
    sidebarSurfaceColor.value =
      settings.sidebarSurfaceColor || DEFAULT_SIDEBAR_SURFACE_COLOR;
  }
  const newTabPosition = document.getElementById('newTabPosition');
  if (newTabPosition) {
    newTabPosition.value = settings.newTabPosition === 'top' ? 'top' : 'bottom';
  }
}

// Function to setup advanced options toggle
function setupAdvancedOptions() {
  const toggle = document.getElementById('advancedOptionsToggle');
  const content = document.getElementById('advancedOptionsContent');

  if (toggle && content) {
    toggle.addEventListener('click', () => {
      const isExpanded = content.style.display !== 'none';
      content.style.display = isExpanded ? 'none' : 'block';
      toggle.classList.toggle('expanded', !isExpanded);
    });
  }

  document.getElementById('resetSidebarSurfaceColor')?.addEventListener('click', () => {
    const picker = document.getElementById('sidebarSurfaceColor');
    if (picker) picker.value = DEFAULT_SIDEBAR_SURFACE_COLOR;
    saveOptions();
  });
}

// Debounce function to avoid excessive saves for color pickers
let saveTimeout;
function debouncedSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveOptions();
  }, 500); // Wait 500ms after last change before saving
}

// Function to setup auto-save listeners
function setupAutoSave() {
  // Auto-save for checkboxes (most just save immediately)
  const checkboxIds = ['enableSpotlight', 'enableSearchSuggestions', 'showAllOpenTabsInCollapsedFolders', 'debugLoggingEnabled'];
  checkboxIds.forEach(id => addListenerIfExists(id, 'change', saveOptions));

  // Auto-archive checkbox needs special handling to update visibility
  const autoArchiveCheckbox = addListenerIfExists('autoArchiveEnabled', 'change', () => {
    updateAutoArchiveIdleMinutesVisibility(autoArchiveCheckbox?.checked);
    saveOptions();
  });

  // Auto-save for number input (with debounce)
  addListenerIfExists('autoArchiveIdleMinutes', 'input', debouncedSave);

  addListenerIfExists('sidebarSurfaceColor', 'input', debouncedSave);
  addListenerIfExists('newTabPosition', 'change', saveOptions);
}

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  setupAdvancedOptions();
  setupAutoSave();
});
