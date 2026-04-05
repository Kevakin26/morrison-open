<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Golfer = Database['public']['Tables']['golfers']['Row']
type GolferInsert = Database['public']['Tables']['golfers']['Insert']

// --- Country flag helper ---
const countryFlags: Record<string, string> = {
  USA: '\u{1F1FA}\u{1F1F8}',
  ENG: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  SCO: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  NIR: '\u{1F3F4}',
  WAL: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
  IRL: '\u{1F1EE}\u{1F1EA}',
  ESP: '\u{1F1EA}\u{1F1F8}',
  JPN: '\u{1F1EF}\u{1F1F5}',
  AUS: '\u{1F1E6}\u{1F1FA}',
  KOR: '\u{1F1F0}\u{1F1F7}',
  RSA: '\u{1F1FF}\u{1F1E6}',
  CAN: '\u{1F1E8}\u{1F1E6}',
  MEX: '\u{1F1F2}\u{1F1FD}',
  GER: '\u{1F1E9}\u{1F1EA}',
  FRA: '\u{1F1EB}\u{1F1F7}',
  ITA: '\u{1F1EE}\u{1F1F9}',
  SWE: '\u{1F1F8}\u{1F1EA}',
  NOR: '\u{1F1F3}\u{1F1F4}',
  DEN: '\u{1F1E9}\u{1F1F0}',
  ARG: '\u{1F1E6}\u{1F1F7}',
  COL: '\u{1F1E8}\u{1F1F4}',
  CHI: '\u{1F1E8}\u{1F1F1}',
  THA: '\u{1F1F9}\u{1F1ED}',
  CHN: '\u{1F1E8}\u{1F1F3}',
  IND: '\u{1F1EE}\u{1F1F3}',
  FIJ: '\u{1F1EB}\u{1F1EF}',
  NZL: '\u{1F1F3}\u{1F1FF}',
  TAI: '\u{1F1F9}\u{1F1FC}',
}

function getFlag(country: string): string {
  const code = country.toUpperCase().trim()
  return countryFlags[code] ?? ''
}

// --- State ---
const golfers = ref<Golfer[]>([])
const loading = ref(true)
const searchQuery = ref('')
const sortBy = ref<'name' | 'world_ranking' | 'odds'>('world_ranking')
const tournamentStatus = ref<string>('pre-draft')

const showModal = ref(false)
const editingGolfer = ref<Golfer | null>(null)
const formName = ref('')
const formCountry = ref('')
const formWorldRanking = ref<number | undefined>(undefined)
const formOdds = ref('')
const saving = ref(false)

const showRemoveDialog = ref(false)
const golferToRemove = ref<Golfer | null>(null)
const removing = ref(false)

let channel: RealtimeChannel | null = null

const isEditable = computed(() => tournamentStatus.value === 'pre-draft')

const filteredGolfers = computed(() => {
  let result = [...golfers.value]

  // Filter by search
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter((g) => g.name.toLowerCase().includes(q))
  }

  // Sort
  if (sortBy.value === 'name') {
    result.sort((a, b) => a.name.localeCompare(b.name))
  } else if (sortBy.value === 'world_ranking') {
    result.sort((a, b) => a.world_ranking - b.world_ranking)
  } else if (sortBy.value === 'odds') {
    result.sort((a, b) => {
      const parseOdds = (o: string | null): number => {
        if (!o) return 99999
        const n = parseInt(o.replace('+', ''), 10)
        return isNaN(n) ? 99999 : n
      }
      return parseOdds(a.odds) - parseOdds(b.odds)
    })
  }

  return result
})

// --- Fetch ---
async function fetchGolfers() {
  loading.value = true
  const { data, error } = await supabase
    .from('golfers')
    .select('*')
    .eq('is_active', true)
    .order('world_ranking', { ascending: true })

  if (!error && data) {
    golfers.value = data
  }
  loading.value = false
}

async function fetchTournamentStatus() {
  const { data } = await supabase
    .from('tournaments')
    .select('status')
    .order('year', { ascending: false })
    .limit(1)
    .single()

  if (data) {
    tournamentStatus.value = data.status
  }
}

// --- Realtime ---
function subscribeToGolfers() {
  channel = supabase
    .channel('golfers-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'golfers' },
      (payload) => {
        const updated = payload.new as Golfer | undefined
        const old = payload.old as { id: string } | undefined

        if (payload.eventType === 'INSERT' && updated?.is_active) {
          golfers.value.push(updated)
        } else if (payload.eventType === 'UPDATE' && updated) {
          const idx = golfers.value.findIndex((g) => g.id === updated.id)
          if (updated.is_active) {
            if (idx >= 0) {
              golfers.value[idx] = updated
            } else {
              golfers.value.push(updated)
            }
          } else {
            // Soft-deleted
            if (idx >= 0) golfers.value.splice(idx, 1)
          }
        } else if (payload.eventType === 'DELETE' && old) {
          const idx = golfers.value.findIndex((g) => g.id === old.id)
          if (idx >= 0) golfers.value.splice(idx, 1)
        }
      }
    )
    .subscribe()
}

// --- Modal ---
function openAddModal() {
  editingGolfer.value = null
  formName.value = ''
  formCountry.value = ''
  formWorldRanking.value = undefined
  formOdds.value = ''
  showModal.value = true
}

function openEditModal(golfer: Golfer) {
  editingGolfer.value = golfer
  formName.value = golfer.name
  formCountry.value = golfer.country
  formWorldRanking.value = golfer.world_ranking
  formOdds.value = golfer.odds ?? ''
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  editingGolfer.value = null
}

async function saveGolfer() {
  if (!formName.value.trim()) return
  saving.value = true

  const payload: GolferInsert = {
    name: formName.value.trim(),
    country: formCountry.value.trim() || 'USA',
    world_ranking: formWorldRanking.value ?? 999,
    odds: formOdds.value.trim() || null,
  }

  if (editingGolfer.value) {
    await supabase
      .from('golfers')
      .update(payload)
      .eq('id', editingGolfer.value.id)
  } else {
    await supabase.from('golfers').insert(payload)
  }

  saving.value = false
  closeModal()
}

// --- Remove ---
function confirmRemove(golfer: Golfer) {
  golferToRemove.value = golfer
  showRemoveDialog.value = true
}

async function removeGolfer() {
  if (!golferToRemove.value) return
  removing.value = true
  await supabase
    .from('golfers')
    .update({ is_active: false })
    .eq('id', golferToRemove.value.id)
  removing.value = false
  showRemoveDialog.value = false
  golferToRemove.value = null
}

// --- Lifecycle ---
onMounted(async () => {
  await Promise.all([fetchGolfers(), fetchTournamentStatus()])
  subscribeToGolfers()
})

onUnmounted(() => {
  if (channel) {
    supabase.removeChannel(channel)
  }
})
</script>

<template>
  <div class="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <div class="flex items-center gap-3">
        <h1 class="text-2xl md:text-3xl font-bold text-dark">Masters Field</h1>
        <span
          class="inline-flex items-center justify-center bg-augusta text-white text-sm font-semibold rounded-full px-3 py-0.5"
        >
          {{ filteredGolfers.length }}
        </span>
      </div>

      <button
        v-if="isEditable"
        @click="openAddModal"
        class="inline-flex items-center gap-2 bg-gold hover:bg-gold/90 text-dark font-semibold px-5 py-2.5 rounded-lg transition-colors shadow-sm cursor-pointer"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
        </svg>
        Add Golfer
      </button>
    </div>

    <!-- Locked banner -->
    <div
      v-if="!isEditable"
      class="bg-augusta-dark/10 border border-augusta-dark/20 text-augusta-dark rounded-lg px-4 py-3 mb-6 text-sm font-medium"
    >
      Field is locked &mdash; draft has started.
    </div>

    <!-- Search & Sort Controls -->
    <div class="flex flex-col sm:flex-row gap-3 mb-6">
      <div class="relative flex-1">
        <svg xmlns="http://www.w3.org/2000/svg" class="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-dark/40" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd" />
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search golfers..."
          class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-dark/15 bg-white focus:outline-none focus:ring-2 focus:ring-augusta/40 focus:border-augusta transition-colors"
        />
      </div>

      <div class="flex gap-1 bg-white border border-dark/15 rounded-lg p-1">
        <button
          @click="sortBy = 'name'"
          :class="[
            'px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer',
            sortBy === 'name' ? 'bg-augusta text-white' : 'text-dark/60 hover:text-dark hover:bg-dark/5',
          ]"
        >
          Name
        </button>
        <button
          @click="sortBy = 'world_ranking'"
          :class="[
            'px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer',
            sortBy === 'world_ranking' ? 'bg-augusta text-white' : 'text-dark/60 hover:text-dark hover:bg-dark/5',
          ]"
        >
          Ranking
        </button>
        <button
          @click="sortBy = 'odds'"
          :class="[
            'px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer',
            sortBy === 'odds' ? 'bg-augusta text-white' : 'text-dark/60 hover:text-dark hover:bg-dark/5',
          ]"
        >
          Odds
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex justify-center py-16">
      <div class="h-8 w-8 border-4 border-augusta/30 border-t-augusta rounded-full animate-spin"></div>
    </div>

    <!-- Empty state -->
    <div v-else-if="filteredGolfers.length === 0" class="text-center py-16 text-dark/50">
      <p class="text-lg">{{ searchQuery ? 'No golfers match your search.' : 'No golfers in the field yet.' }}</p>
      <button
        v-if="isEditable && !searchQuery"
        @click="openAddModal"
        class="mt-4 text-augusta font-medium hover:underline cursor-pointer"
      >
        Add the first golfer
      </button>
    </div>

    <!-- Golfer Grid -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <div
        v-for="golfer in filteredGolfers"
        :key="golfer.id"
        class="bg-white rounded-xl shadow-sm border border-dark/8 p-4 hover:shadow-md transition-shadow"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <h3 class="font-bold text-dark text-lg leading-tight truncate">{{ golfer.name }}</h3>
            <p class="text-dark/60 text-sm mt-0.5">
              <span v-if="getFlag(golfer.country)" class="mr-1">{{ getFlag(golfer.country) }}</span>
              {{ golfer.country }}
            </p>
          </div>

          <!-- Actions -->
          <div v-if="isEditable" class="flex items-center gap-1 shrink-0">
            <button
              @click="openEditModal(golfer)"
              class="p-1.5 rounded-md text-dark/40 hover:text-augusta hover:bg-augusta/10 transition-colors cursor-pointer"
              title="Edit"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
              </svg>
            </button>
            <button
              @click="confirmRemove(golfer)"
              class="p-1.5 rounded-md text-dark/40 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
              title="Remove"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        <div class="flex items-center gap-4 mt-3 pt-3 border-t border-dark/8">
          <div>
            <span class="text-xs text-dark/40 uppercase tracking-wide">Rank</span>
            <p class="font-semibold text-dark font-score">#{{ golfer.world_ranking }}</p>
          </div>
          <div>
            <span class="text-xs text-dark/40 uppercase tracking-wide">Odds</span>
            <p class="font-semibold text-augusta font-score">{{ golfer.odds ?? '—' }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Modal -->
    <Teleport to="body">
      <div
        v-if="showModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        @click.self="closeModal"
      >
        <div class="fixed inset-0 bg-black/50" @click="closeModal"></div>
        <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 z-10">
          <h2 class="text-xl font-bold text-dark mb-5">
            {{ editingGolfer ? 'Edit Golfer' : 'Add Golfer' }}
          </h2>

          <form @submit.prevent="saveGolfer" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-dark/70 mb-1">Name</label>
              <input
                v-model="formName"
                type="text"
                required
                placeholder="Scottie Scheffler"
                class="w-full px-3 py-2.5 rounded-lg border border-dark/15 focus:outline-none focus:ring-2 focus:ring-augusta/40 focus:border-augusta transition-colors"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-dark/70 mb-1">Country</label>
              <input
                v-model="formCountry"
                type="text"
                placeholder="USA"
                class="w-full px-3 py-2.5 rounded-lg border border-dark/15 focus:outline-none focus:ring-2 focus:ring-augusta/40 focus:border-augusta transition-colors"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-dark/70 mb-1">World Ranking</label>
              <input
                v-model.number="formWorldRanking"
                type="number"
                min="1"
                placeholder="1"
                class="w-full px-3 py-2.5 rounded-lg border border-dark/15 focus:outline-none focus:ring-2 focus:ring-augusta/40 focus:border-augusta transition-colors"
              />
            </div>

            <div>
              <label class="block text-sm font-medium text-dark/70 mb-1">Odds</label>
              <input
                v-model="formOdds"
                type="text"
                placeholder="+1200"
                class="w-full px-3 py-2.5 rounded-lg border border-dark/15 focus:outline-none focus:ring-2 focus:ring-augusta/40 focus:border-augusta transition-colors"
              />
            </div>

            <div class="flex gap-3 pt-2">
              <button
                type="submit"
                :disabled="saving || !formName.trim()"
                class="flex-1 bg-augusta hover:bg-augusta-dark text-white font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {{ saving ? 'Saving...' : 'Save' }}
              </button>
              <button
                type="button"
                @click="closeModal"
                class="flex-1 bg-dark/10 hover:bg-dark/15 text-dark font-semibold py-2.5 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- Remove Confirmation Dialog -->
    <Teleport to="body">
      <div
        v-if="showRemoveDialog"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        @click.self="showRemoveDialog = false"
      >
        <div class="fixed inset-0 bg-black/50" @click="showRemoveDialog = false"></div>
        <div class="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 z-10 text-center">
          <h3 class="text-lg font-bold text-dark mb-2">Remove Golfer</h3>
          <p class="text-dark/60 mb-6">
            Remove <span class="font-semibold text-dark">{{ golferToRemove?.name }}</span> from the field?
          </p>
          <div class="flex gap-3">
            <button
              @click="removeGolfer"
              :disabled="removing"
              class="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            >
              {{ removing ? 'Removing...' : 'Remove' }}
            </button>
            <button
              @click="showRemoveDialog = false"
              class="flex-1 bg-dark/10 hover:bg-dark/15 text-dark font-semibold py-2.5 rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
