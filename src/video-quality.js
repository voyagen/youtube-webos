import { configRead, configAddChangeListener, configRemoveChangeListener } from './config.js';
import { showNotification } from './notifications.js';
import { isWebOS25 } from './webos-utils.js';
import { sendKey, REMOTE_KEYS, SELECTORS, isWatchPage } from './utils.js';

const DEBUG = false;

const TARGET_QUALITIES = [
  'highres', 'hd2880', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'
];

const IS_WEBOS_25 = isWebOS25();
const QUALITY_KEY = 'yt-player-quality';
const ONE_YEAR_MS = 31536000000; // 365 * 24 * 60 * 60 * 1000

// Caching: In-memory cache for localStorage & Config
let cachedQualitySettings = null;
let _shouldForce = false;

let player = null;
let lastVideoId = null;
let initTimer = null;
let configCleanup = null;
let isDestroyed = false;
let lastWriteTime = 0;
let statePollingInterval = null;
let lastKnownState = null;
let _isWatchPageCached = false;
let videoBeingProcessed = null;
let kickstartInProgress = false;

const qualitySetForVideo = new Set();

// webOS 25 first video fix
let hasKickstarted = false;

// Player States
const STATE_UNSTARTED = -1;
// const STATE_ENDED = 0;
const STATE_PLAYING = 1;
// const STATE_PAUSED = 2;
const STATE_BUFFERING = 3;
// const STATE_CUED = 5;

function isForceEnabled() {
  return _shouldForce && (!player?.isInline || !player.isInline());
}

async function ensurePlaybackStarts() {
  if (!IS_WEBOS_25 || hasKickstarted || isDestroyed || !player || kickstartInProgress) return;

  kickstartInProgress = true;
  if (DEBUG) console.info('[VideoQuality] 🚀 Starting playback enforcer...');

  const MAX_ATTEMPTS = 10;
  const INTERVAL_MS = 500;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (isDestroyed || !player || hasKickstarted) {
      kickstartInProgress = false;
      return;
    }

    try {
      const currentState = player.getPlayerState?.();

      if (currentState === STATE_PLAYING) {
        hasKickstarted = true;
        kickstartInProgress = false;
        if (DEBUG) console.info('[VideoQuality] ✅ Playback verified! Kickstart complete.');
        
        requestAnimationFrame(() => {
            const controls = document.querySelector('yt-focus-container[idomkey="controls"]');
            const isControlsVisible = controls && controls.classList.contains('MFDzfe--focused');

            if (isControlsVisible) {
                if (DEBUG) console.info('[VideoQuality] 🎮 Controls are focused. Hiding and dismissing...');

                const hideStyle = document.createElement('style');
                hideStyle.textContent = '.GLc3cc { opacity: 0 !important; transition: opacity 0.1s; }';
                document.head.appendChild(hideStyle);

                sendKey(REMOTE_KEYS.UP);                            
                setTimeout(() => sendKey(REMOTE_KEYS.UP), 250);     
                setTimeout(() => sendKey(REMOTE_KEYS.UP), 500);     

                setTimeout(() => {
                    if (hideStyle.isConnected) hideStyle.remove();
                }, 750);
            }
        });
        
        return;
      }

      if (DEBUG) console.log(`[VideoQuality] 👊 Kick attempt ${i + 1}/${MAX_ATTEMPTS} (State: ${currentState})`);
      player.playVideo?.();

    } catch (e) {
      if (DEBUG) console.warn('[VideoQuality] Kick attempt failed:', e);
    }
	
	// eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }

  kickstartInProgress = false;
  if (DEBUG && !hasKickstarted) {
    console.warn('[VideoQuality] ⚠️ Playback enforcer timed out without confirming PLAYING state.');
  }
}

// Highest level the current video offers, or null until the player lists
// levels it recognises (e.g. [] before the manifest loads, or only 'auto').
function getBestAvailableQuality() {
  if (!player) return null;
  try {
    const available = player.getAvailableQualityLevels?.();
    if (!Array.isArray(available)) return null;
    return TARGET_QUALITIES.find(quality => available.includes(quality)) || null;
  } catch {
    return null;
  }
}

function setLocalStorageQuality() {
  if (!isForceEnabled()) return false;
  
  const now = Date.now();
  if (now - lastWriteTime < 2000) return false;

  if (cachedQualitySettings && cachedQualitySettings.quality === 4320) {
    return false; 
  }
  
  try {
    if (!cachedQualitySettings) {
      const stored = window.localStorage.getItem(QUALITY_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.data) {
             cachedQualitySettings = JSON.parse(parsed.data);
          }
        } catch { /* ignore */ }
      }
    }

    if (cachedQualitySettings && 
        cachedQualitySettings.quality === 4320 && 
        cachedQualitySettings.previousQuality === 4320) {
        return false; 
    }

    const innerData = { quality: 4320, previousQuality: 4320 };
      
    const qualityObj = {
      data: JSON.stringify(innerData),
      creation: now,
      expiration: now + ONE_YEAR_MS
    };
    
    window.localStorage.setItem(QUALITY_KEY, JSON.stringify(qualityObj));
    cachedQualitySettings = innerData;
    lastWriteTime = now;
    
    DEBUG && console.info('[VideoQuality] Set localStorage quality to 4320p');
    return true;
    
  } catch (e) {
    DEBUG && console.warn('[VideoQuality] Failed to set localStorage quality:', e);
    return false;
  }
}

// `upgraded` means a switch was requested; notifyIfUpgraded() confirms it.
function setQualityOnPlayer(best) {
  if (!player || !isForceEnabled() || isDestroyed) {
    return { success: false, upgraded: false };
  }
  
  try {
    if (!player.setPlaybackQualityRange) {
      return { success: false, upgraded: false };
    }
    
    const previousQuality = player.getPlaybackQuality?.();
    if (previousQuality === best) {
      return { success: true, upgraded: false };
    }
    
    DEBUG && console.log('[VideoQuality] Upgrading quality from:', previousQuality, 'to:', best);
    
    player.setPlaybackQualityRange(best, best);
    player.setPlaybackQuality?.(best);
    
    return { success: true, upgraded: true, previousQuality };
    
  } catch (e) {
    DEBUG && console.warn('[VideoQuality] Error setting quality:', e);
    return { success: false, upgraded: false };
  }
}

function notifyIfUpgraded(result) {
  if (result && result.upgraded) {
    setTimeout(() => {
      try {
        // The switch is async; stay quiet unless the player actually moved.
        if (isDestroyed || !player) return;
        const quality = player.getPlaybackQuality?.();
        if (!quality || quality === result.previousQuality) return;
        const finalQuality = player.getPlaybackQualityLabel?.() || quality;
        showNotification(`Video quality upgraded to ${finalQuality}`);
        DEBUG && console.info('[VideoQuality] Notification shown:', finalQuality);
      } catch { /* ignore */ }
    }, 500);
  }
}

function interceptAndUpgradeQuality(videoId, best) {
  if (!player || !isForceEnabled() || isDestroyed) return;
  
  if (videoBeingProcessed === videoId) return;
  
  videoBeingProcessed = videoId;
  DEBUG && console.info('[VideoQuality] 🛑 Intercepting playback to upgrade quality:', videoId);
  
  const currentState = player.getPlayerState?.();
  const wasPlaying = currentState === STATE_PLAYING;
  
  try {
    if (wasPlaying) player.pauseVideo?.();
  } catch { /* ignore */ }
  
  requestAnimationFrame(() => {
    const result = setQualityOnPlayer(best);
    
    if (result.success) {
      qualitySetForVideo.add(videoId);
    }
    
    requestAnimationFrame(() => {
      if (wasPlaying) {
        try {
          player.playVideo?.();
        } catch { /* ignore */ }
      }
      notifyIfUpgraded(result);
      videoBeingProcessed = null;
    });
  });
}

function handleStateChange(state) {
  if (isDestroyed || !player) return;

  const actualState = (state && state.data !== undefined) ? state.data : state;

  // State events are shared infrastructure and must not depend on quality forcing.
  let videoId = null;
  try {
    videoId = player.getVideoData?.()?.video_id || null;
  } catch { /* The player may not have video data yet. */ }
  const isNewVideo = !!videoId && videoId !== lastVideoId;
  if (videoId) lastVideoId = videoId;

  window.dispatchEvent(new CustomEvent('yt-player-state-change', {
    detail: { state: actualState, videoId }
  }));

  if (!_shouldForce || !videoId) return;

  try {
    if (isNewVideo) {
      DEBUG && console.info('[VideoQuality] 🎬 New video:', videoId);
      
      if (actualState === STATE_UNSTARTED) {
          setLocalStorageQuality();
      }
    }
    
    if (qualitySetForVideo.has(videoId)) {
      if (actualState === STATE_PLAYING) ensurePlaybackStarts();
      return;
    }
    
    // Until the player lists its levels there is nothing to compare against;
    // a later state change retries.
    const best = getBestAvailableQuality();

    if (best) {
      switch (actualState) {
          // Upgrading while the video isn't playing yet needs no interrupt.
          // setQualityOnPlayer() short-circuits when already at `best`.
          case STATE_UNSTARTED:
          case STATE_BUFFERING: {
              const result = setQualityOnPlayer(best);
              if (result.success) qualitySetForVideo.add(videoId);
              notifyIfUpgraded(result);
              break;
          }

          case STATE_PLAYING:
              if (player.getPlaybackQuality?.() === best) {
                  qualitySetForVideo.add(videoId);
              } else {
                  interceptAndUpgradeQuality(videoId, best);
              }
              break;
      }
    }

	ensurePlaybackStarts();
  } catch (e) {
    DEBUG && console.warn('[VideoQuality] Error in state change handler:', e);
  }
}

function startStatePolling() {
  if (statePollingInterval) return;
  
  DEBUG && console.info('[VideoQuality] Starting state polling (Fallback)');
  
  statePollingInterval = setInterval(() => {
    if (isDestroyed || !player) {
      stopStatePolling();
      return;
    }
    try {
      const state = player.getPlayerState?.();
      if (state !== lastKnownState) {
        lastKnownState = state;
        handleStateChange(state);
      }
    } catch { /* ignore */ }
  }, 250);
}

function stopStatePolling() {
  if (statePollingInterval) {
    clearInterval(statePollingInterval);
    statePollingInterval = null;
  }
}

export function destroyVideoQuality() {
  DEBUG && console.info('[VideoQuality] Destroying');
  
  isDestroyed = true;
  
  if (initTimer) {
    clearTimeout(initTimer);
    initTimer = null;
  }
  
  stopStatePolling();
  
  if (player) {
    try {
      player.removeEventListener?.('onStateChange', handleStateChange);
    } catch { /* ignore */ }
  }
  
  if (configCleanup) {
    try {
      configCleanup();
    } catch { /* ignore */ }
  }
  
  player = null;
  lastVideoId = null;
  lastKnownState = null;
  configCleanup = null;
  qualitySetForVideo.clear();
  videoBeingProcessed = null;
  _isWatchPageCached = false;
  kickstartInProgress = false;
  // Don't reset hasKickstarted here so it persists for the session
}

export function initVideoQuality() {
  if (initTimer || player) return;
  
  DEBUG && console.info('[VideoQuality] Initializing');
  
  isDestroyed = false;
  _isWatchPageCached = true;
  
  _shouldForce = configRead('forceHighResVideo');
  
  setLocalStorageQuality();
  
  const attach = () => {
    if (isDestroyed) return true;
    
    const p = document.getElementById(SELECTORS.PLAYER_ID);
    if (!p || !p.setPlaybackQualityRange || !p.isConnected) {
      return false;
    }
    
    try {
      player = p;
      let listenerAttached = false;
      
      try {
        if (player.addEventListener) {
            player.addEventListener('onStateChange', handleStateChange);
            listenerAttached = true;
            DEBUG && console.log('[VideoQuality] Native listener attached');
        }
      } catch (e) {
        DEBUG && console.warn('[VideoQuality] Event listener failed, falling back to poll:', e);
      }
      
      if (!listenerAttached) {
          startStatePolling();
      }
      
      if (configAddChangeListener && !configCleanup) {
        const onChange = (evt) => {
          if (isDestroyed) return;
          _shouldForce = !!evt.detail.newValue;
          
          if (_shouldForce) {
            cachedQualitySettings = null;
            setLocalStorageQuality();
            qualitySetForVideo.clear();
          }
        };
        configCleanup = configAddChangeListener('forceHighResVideo', onChange) || 
          (() => configRemoveChangeListener?.('forceHighResVideo', onChange));
      }
      
      DEBUG && console.info('[VideoQuality] ✅ Attached to player');
      
      handleStateChange(player.getPlayerState?.());
      
      return true;
    } catch (e) {
      DEBUG && console.warn('[VideoQuality] Error attaching:', e);
      player = null;
      return false;
    }
  };

  if (attach()) return;

  let attempts = 0;
  const poll = () => {
    if (isDestroyed) {
      clearTimeout(initTimer);
      initTimer = null;
      return;
    }
    if (attach() || attempts++ >= 50) {
      clearTimeout(initTimer);
      initTimer = null;
    } else {
      initTimer = setTimeout(poll, 200);
    }
  };
  
  poll();
}

function handleNavigation(event) {
  const isWatch = (event?.detail?.pageType === 'watch') || isWatchPage();
  
  if (isWatch && !_isWatchPageCached) {
    DEBUG && console.info('[VideoQuality] Navigation: Entering watch page');
    setTimeout(initVideoQuality, 0); 
    
  } else if (!isWatch && _isWatchPageCached) {
    DEBUG && console.info('[VideoQuality] Navigation: Leaving watch page');
    destroyVideoQuality();
  }
}

function setupListeners() {
    window.addEventListener('yt-navigate-finish', handleNavigation);

    // Passed directly: handleNavigation falls back to isWatchPage() when the
    // event carries no pageType, and ytaf-page-update never does.
    window.addEventListener('ytaf-page-update', handleNavigation);
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => handleNavigation());
    } else {
        handleNavigation();
    }
    
    window.addEventListener('beforeunload', destroyVideoQuality);
}

setupListeners();