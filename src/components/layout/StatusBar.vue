<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { useUpdaterStore } from '@/stores/updater';
import { useUpdateCheck } from '@/composables/useUpdateCheck';
import { getVersion } from '@tauri-apps/api/app';

const settings = useSettingsStore();
const updater = useUpdaterStore();
const { manualCheck } = useUpdateCheck();
const appVersion = ref('');

const copyright = '© 2026 Leaderxin · Fork 维护 CGodX';

onMounted(async () => {
  try {
    appVersion.value = await getVersion();
  } catch {
    appVersion.value = '';
  }
});
</script>

<template>
  <footer class="status-bar">
    <!-- Zone 1: System info -->
    <div class="sb-zone sb-info">
      <span class="sb-version" v-if="appVersion">v{{ appVersion }}</span>
      <button
        v-if="settings.updaterAvailable"
        class="sb-check-btn"
        :class="{ 'sb-up-to-date': updater.isUpToDate }"
        :disabled="updater.updateStatus === 'checking'"
        @click="manualCheck"
      >
        {{ updater.updateStatus === 'checking' ? '检查中...' : updater.isUpToDate ? '已是最新版本' : '检查更新' }}
      </button>
      <span class="sb-sep">·</span>
      <span class="sb-copyright">{{ copyright }}</span>
    </div>

    <!-- Zone 2: Settings -->
    <div class="sb-zone sb-settings">
      <button
        class="sb-icon-btn"
        :aria-label="settings.theme === 'dark' ? '切换到浅色主题' : '切换到暗色主题'"
        :title="settings.theme === 'dark' ? '浅色主题' : '暗色主题'"
        @click="settings.toggleTheme()"
      >
        <svg v-if="settings.theme === 'dark'" viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path d="M10 2a.75.75 0 01.75.75v.5a.75.75 0 01-1.5 0v-.5A.75.75 0 0110 2zM10 16a.75.75 0 01.75.75v.5a.75.75 0 01-1.5 0v-.5A.75.75 0 0110 16zM4.46 4.46a.75.75 0 011.06 0l.354.354a.75.75 0 01-1.06 1.06l-.354-.353a.75.75 0 010-1.06zM14.126 14.126a.75.75 0 011.06 0l.354.354a.75.75 0 01-1.06 1.06l-.354-.353a.75.75 0 010-1.06zM2 10a.75.75 0 01.75-.75h.5a.75.75 0 010 1.5h-.5A.75.75 0 012 10zM16 9.25a.75.75 0 000 1.5h.5a.75.75 0 000-1.5H16zM4.813 14.126a.75.75 0 010 1.06l-.353.354a.75.75 0 01-1.06-1.06l.353-.354a.75.75 0 011.06 0zM14.126 4.46a.75.75 0 010 1.06l-.353.354a.75.75 0 11-1.06-1.06l.353-.354a.75.75 0 011.06 0zM10 6.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"/>
        </svg>
        <svg v-else viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
          <path fill-rule="evenodd" d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z" clip-rule="evenodd"/>
        </svg>
      </button>

      <span class="sb-sep">·</span>

      <button
        class="sb-autolaunch"
        role="switch"
        :aria-checked="settings.autoLaunch"
        :aria-label="`开机自启：${settings.autoLaunch ? '已开启' : '已关闭'}`"
        @click.stop="settings.toggleAutoLaunch()"
      >
        <span class="sb-autolaunch-label">开机自启</span>
        <span class="sb-toggle" :class="{ on: settings.autoLaunch }">
          <span class="sb-toggle-knob"></span>
        </span>
      </button>
    </div>

  </footer>
</template>

<style scoped>
/* ── Status bar container ── */
.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 28px;
  padding: 0 var(--space-4);
  background: var(--color-surface-1);
  border-top: 1px solid var(--color-border-0);
  flex-shrink: 0;
  font-size: var(--text-xs);
  line-height: 1;
  color: var(--color-text-tertiary);
}

/* ── Zones ── */
.sb-zone {
  display: flex;
  align-items: center;
  height: 100%;
  gap: var(--space-2);
}

/* ── Separator dot ── */
.sb-sep {
  color: var(--color-border-1);
  user-select: none;
  font-weight: var(--font-weight-bold);
  line-height: 1;
}

/* ── Zone 1: Info ── */
.sb-version {
  font-weight: var(--font-weight-medium);
  color: var(--color-accent);
  font-family: var(--font-mono);
  line-height: 1;
}
.sb-check-btn {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  line-height: 1;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.sb-check-btn:hover:not(:disabled) {
  color: var(--color-accent);
  background: var(--color-bg-elevated);
}
.sb-check-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.sb-check-btn.sb-up-to-date {
  color: #3fb950;
}
.sb-copyright {
  color: var(--color-text-tertiary);
  line-height: 1;
}

/* ── Zone 2: Settings (icon buttons + toggles) ── */
.sb-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.sb-icon-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
}

/* Auto-launch toggle with label */
.sb-autolaunch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
  user-select: none;
}
.sb-autolaunch-label {
  color: var(--color-text-tertiary);
  line-height: 1;
  transition: color var(--transition-fast);
}
.sb-autolaunch:hover .sb-autolaunch-label {
  color: var(--color-text-secondary);
}

/* Toggle switch pill */
.sb-toggle {
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: var(--radius-full);
  background: var(--color-border-1);
  transition: background var(--transition-fast);
  flex-shrink: 0;
}
.sb-toggle.on {
  background: var(--color-accent);
}
.sb-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--transition-fast);
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.sb-toggle.on .sb-toggle-knob {
  transform: translateX(11px);
}

</style>
