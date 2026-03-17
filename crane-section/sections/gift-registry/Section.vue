<template>
  <section class="gr-section">
    <!-- Header -->
    <div v-if="title || subtitle" class="gr-heading">
      <h2 v-if="title" class="gr-title">
        {{ title }}
      </h2>
      <p v-if="subtitle" class="gr-subtitle">
        {{ subtitle }}
      </p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="gr-loading" aria-live="polite">
      Loading registries…
    </div>

    <!-- Error -->
    <div v-else-if="error" class="gr-error" role="alert">
      {{ error }}
    </div>

    <!-- Detail view -->
    <template v-else-if="activeRegistry">
      <button class="gr-back-btn" @click="activeRegistry = null">
        ← {{ backLabel }}
      </button>
      <div class="gr-detail-header">
        <h3 class="gr-detail-title">
          {{ activeRegistry.display_name }}
        </h3>
        <p v-if="activeRegistry.event_date" class="gr-detail-date">
          {{ formatDate(activeRegistry.event_date) }}
        </p>
      </div>
      <div v-if="statusMsg" :class="['gr-status', statusMsg.ok ? 'gr-status--ok' : 'gr-status--err']">
        {{ statusMsg.text }}
      </div>
      <div v-if="items.length === 0" class="gr-empty">
        No items on this registry.
      </div>
      <div v-else class="gr-items">
        <div v-for="item in items" :key="item.id" class="gr-item">
          <div class="gr-item-info">
            <div class="gr-item-name">
              {{ item.product_name || 'Registry item' }}
            </div>
            <div class="gr-item-meta">
              Wanted: {{ item.desired_qty }} &nbsp;·&nbsp;
              Purchased: {{ item.purchased_qty }} &nbsp;·&nbsp;
              Still needed: {{ item.still_needed }}
            </div>
          </div>
          <button
            v-if="item.still_needed > 0 && item.product_id"
            class="gr-btn"
            :disabled="addingId === item.product_id"
            @click="addToCart(item)"
          >
            {{ addingId === item.product_id ? 'Adding…' : addToCartLabel }}
          </button>
          <span v-else-if="item.still_needed === 0" class="gr-fulfilled">
            ✓ Fulfilled
          </span>
        </div>
      </div>
    </template>

    <!-- List view -->
    <template v-else>
      <input
        v-model="search"
        class="gr-search"
        type="search"
        :placeholder="searchPlaceholder"
        @input="onSearch"
      />
      <div v-if="registries.length === 0" class="gr-empty">
        {{ emptyMessage }}
      </div>
      <div v-else :class="['gr-list', gridStyle]">
        <div
          v-for="reg in registries"
          :key="reg.id"
          class="gr-card"
          role="button"
          tabindex="0"
          @click="openRegistry(reg.id)"
          @keydown.enter="openRegistry(reg.id)"
        >
          <div class="gr-card-name">
            {{ reg.display_name }}
          </div>
          <div class="gr-card-meta">
            <span v-if="reg.event_date">
              {{ formatDate(reg.event_date) }} ·
            </span>
            {{ reg.item_count }} items
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  useInputboxElementContent,
  useSelectboxElementDesign,
} from '@lightspeed/crane-api';

// ── Content settings (editable in Ecwid Site Editor) ──────────────────────
const titleSetting = useInputboxElementContent('title');
const subtitleSetting = useInputboxElementContent('subtitle');
const serverUrlSetting = useInputboxElementContent('server_url');
const searchPlaceholderSetting = useInputboxElementContent('search_placeholder');
const addToCartLabelSetting = useInputboxElementContent('add_to_cart_label');
const backLabelSetting = useInputboxElementContent('back_label');
const emptyMessageSetting = useInputboxElementContent('empty_message');
const columnsSetting = useSelectboxElementDesign('columns');

const title = computed(() => titleSetting.value ?? 'Gift Registries');
const subtitle = computed(() => subtitleSetting.value ?? '');
const serverUrl = computed(
  () => (serverUrlSetting.value ?? '').replace(/\/$/, ''),
);
const searchPlaceholder = computed(
  () => searchPlaceholderSetting.value ?? 'Search by name…',
);
const addToCartLabel = computed(
  () => addToCartLabelSetting.value ?? 'Add to cart',
);
const backLabel = computed(() => backLabelSetting.value ?? 'Back');
const emptyMessage = computed(
  () => emptyMessageSetting.value ?? 'No registries found.',
);

const gridStyle = computed(() => {
  const cols = columnsSetting.value ?? 'auto';
  return cols === 'auto' ? 'gr-list--auto' : `gr-list--${cols}col`;
});

// ── Types ─────────────────────────────────────────────────────────────────
interface Registry {
  id: number;
  display_name: string;
  event_date?: string;
  item_count?: number;
}

interface RegistryItem {
  id: number;
  product_id?: number;
  product_name?: string;
  desired_qty: number;
  purchased_qty: number;
  still_needed: number;
}

// ── State ─────────────────────────────────────────────────────────────────
const registries    = ref<Registry[]>([]);
const items         = ref<RegistryItem[]>([]);
const activeRegistry = ref<Registry | null>(null);
const loading       = ref(true);
const error         = ref('');
const search        = ref('');
const addingId      = ref<number | null>(null);
const statusMsg     = ref<{ ok: boolean; text: string } | null>(null);
let   searchTimer: ReturnType<typeof setTimeout> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function formatDate(str: string) {
  if (!str) return '';
  const d = new Date(str);
  return isNaN(d.getTime()) ? str : d.toLocaleDateString();
}

function getStoreId(): string {
  if (typeof window === 'undefined') return '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as Record<string, any>;
  return String(w.Ecwid?.getOwnerId?.() ?? w.ecwid_store_id ?? '');
}

// ── Data fetching ─────────────────────────────────────────────────────────
async function loadRegistries(q = '') {
  loading.value = true;
  error.value   = '';
  try {
    const storeId = getStoreId();
    const params  = new URLSearchParams();
    if (storeId) params.set('store_id', storeId);
    if (q)       params.set('q', q);
    const res = await fetch(`${serverUrl.value}/api/registries?${params}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    registries.value = await res.json();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Could not load registries: ${msg}`;
  } finally {
    loading.value = false;
  }
}

async function openRegistry(id: number) {
  loading.value = true;
  error.value   = '';
  statusMsg.value = null;
  try {
    const res = await fetch(`${serverUrl.value}/api/registries/${id}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    activeRegistry.value = data.registry;
    items.value          = data.items ?? [];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = `Could not load registry: ${msg}`;
  } finally {
    loading.value = false;
  }
}

// ── Search ────────────────────────────────────────────────────────────────
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRegistries(search.value.trim()), 350);
}

// ── Cart integration ──────────────────────────────────────────────────────
function trackItem(productId: number, registry: Registry) {
  try {
    const stored = JSON.parse(localStorage.getItem('_reg_items') ?? '{}');
    const pid    = String(productId);
    const entries: Array<{ rid: number; name: string; qty: number }> =
      Array.isArray(stored[pid]) ? stored[pid] : [];
    const idx = entries.findIndex((e) => e.rid === registry.id);
    if (idx >= 0) {
      entries[idx].qty = (entries[idx].qty ?? 1) + 1;
    } else {
      entries.push({ rid: registry.id, name: registry.display_name, qty: 1 });
    }
    stored[pid] = entries;
    localStorage.setItem('_reg_items', JSON.stringify(stored));
  } catch { /* localStorage may be unavailable */ }
}

async function addToCart(item: RegistryItem) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as Record<string, any>;
  if (!w.Ecwid?.Cart?.addProduct) {
    statusMsg.value = { ok: false, text: 'Cart not available — try from the product page.' };
    return;
  }
  addingId.value  = item.product_id;
  statusMsg.value = null;
  await new Promise<void>((resolve) => {
    w.Ecwid.Cart.addProduct(item.product_id, 1, (success: boolean) => {
      if (success !== false) {
        trackItem(item.product_id, activeRegistry.value);
        statusMsg.value = { ok: true, text: 'Added to cart!' };
      } else {
        statusMsg.value = { ok: false, text: 'Could not add item. Please try again.' };
      }
      resolve();
    });
    // Fallback: assume success after 2 s if no callback fires
    setTimeout(() => {
      if (addingId.value === item.product_id) {
        trackItem(item.product_id, activeRegistry.value);
        statusMsg.value = { ok: true, text: 'Added to cart!' };
        resolve();
      }
    }, 2000);
  });
  addingId.value = null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => loadRegistries());

// Re-fetch when serverUrl changes in the editor
watch(serverUrl, () => {
  if (!activeRegistry.value) loadRegistries(search.value.trim());
});
</script>

<style scoped>
/* All colours inherit from the Instant Site theme via currentColor / inherit.
   Only structural rules are defined here so the section naturally matches
   the merchant's chosen site theme. */

.gr-section {
  padding: 32px 24px;
  font-family: inherit;
  color: inherit;
}

.gr-heading { margin-bottom: 24px; }
.gr-title   { font-size: 2rem; font-weight: 700; margin: 0 0 4px; }
.gr-subtitle { font-size: 1rem; opacity: 0.65; margin: 0; }

.gr-loading,
.gr-error,
.gr-empty { opacity: 0.6; font-size: 0.95rem; padding: 12px 0; }
.gr-error { color: #c0392b; opacity: 1; }

/* Search */
.gr-search {
  display: block;
  width: 100%;
  max-width: 420px;
  padding: 10px 18px;
  margin-bottom: 20px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-family: inherit;
  font-size: 0.9rem;
  background: transparent;
  color: inherit;
  opacity: 0.85;
  transition: opacity 0.15s;
}
.gr-search:focus { outline: none; opacity: 1; }

/* Registry cards */
.gr-list { display: grid; gap: 16px; }
.gr-list--auto { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.gr-list--1col { grid-template-columns: 1fr; }
.gr-list--2col { grid-template-columns: repeat(2, 1fr); }
.gr-list--3col { grid-template-columns: repeat(3, 1fr); }
.gr-list--4col { grid-template-columns: repeat(4, 1fr); }

.gr-card {
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 18px 20px;
  cursor: pointer;
  opacity: 0.9;
  transition: opacity 0.15s, box-shadow 0.15s;
}
.gr-card:hover, .gr-card:focus { opacity: 1; box-shadow: 0 4px 16px rgba(0,0,0,0.1); outline: none; }
.gr-card-name { font-size: 1.05rem; font-weight: 600; margin-bottom: 4px; }
.gr-card-meta { font-size: 0.8rem; opacity: 0.6; }

/* Detail view */
.gr-back-btn {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  padding: 7px 14px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  margin-bottom: 20px;
  opacity: 0.75;
  transition: opacity 0.15s;
}
.gr-back-btn:hover { opacity: 1; }

.gr-detail-header { margin-bottom: 20px; }
.gr-detail-title  { font-size: 1.6rem; font-weight: 700; margin: 0 0 4px; }
.gr-detail-date   { font-size: 0.85rem; opacity: 0.55; margin: 0; }

.gr-status          { padding: 10px 14px; border-radius: 4px; font-size: 0.9rem; margin-bottom: 16px; }
.gr-status--ok  { background: rgba(42,110,63,0.1);  color: #2a6e3f; }
.gr-status--err { background: rgba(192,57,43,0.1);  color: #c0392b; }

.gr-items { display: grid; gap: 10px; }
.gr-item  {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 12px 16px;
  opacity: 0.9;
}
.gr-item-info { flex: 1; min-width: 0; }
.gr-item-name { font-weight: 600; font-size: 0.95rem; margin-bottom: 2px; }
.gr-item-meta { font-size: 0.8rem; opacity: 0.6; }

.gr-btn {
  flex-shrink: 0;
  padding: 8px 14px;
  border: none;
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  background: currentColor;
  color: inherit;
  filter: invert(1);
  transition: opacity 0.15s;
}
.gr-btn:hover    { opacity: 0.85; }
.gr-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.gr-fulfilled {
  font-size: 0.8rem;
  color: #2a6e3f;
  flex-shrink: 0;
}

@media (max-width: 600px) {
  .gr-item  { flex-direction: column; align-items: flex-start; }
  .gr-btn   { width: 100%; text-align: center; }
  .gr-list--2col,
  .gr-list--3col,
  .gr-list--4col { grid-template-columns: 1fr; }
}
</style>
