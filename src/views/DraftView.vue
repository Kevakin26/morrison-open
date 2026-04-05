<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Tournament = Database['public']['Tables']['tournaments']['Row']
type DraftPick = Database['public']['Tables']['draft_picks']['Row']
type Golfer = Database['public']['Tables']['golfers']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']

interface DraftState {
  id: string
  tournament_id: string
  status: string
  draft_order: string[]  // array of user UUIDs in snake order
  current_pick_index: number
  pick_deadline: string | null
  created_at: string
}

const auth = useAuthStore()

// Core data
const tournament = ref<Tournament | null>(null)
const draftState = ref<DraftState | null>(null)
const draftPicks = ref<DraftPick[]>([])
const golfers = ref<Golfer[]>([])
const profiles = ref<Profile[]>([])
const loading = ref(true)

// UI state
const searchQuery = ref('')
const selectedGolfer = ref<Golfer | null>(null)
const pickLoading = ref(false)
const pickError = ref('')

// Timer
const timerSeconds = ref(0)
let timerInterval: ReturnType<typeof setInterval> | null = null

// Realtime channels
const channels: RealtimeChannel[] = []

// Track if we already notified for the current pick
let lastNotifiedPickIndex = -1

// ─── Computed ───

const numPlayers = computed(() => {
  return draftState.value?.draft_order?.length
    ? new Set(draftState.value.draft_order).size
    : 0
})

const totalPicks = computed(() => draftState.value?.draft_order?.length ?? 0)

const picksPerPlayer = computed(() => {
  if (!numPlayers.value) return 4
  return Math.floor(totalPicks.value / numPlayers.value)
})

const currentRound = computed(() => {
  if (!draftState.value || !numPlayers.value) return 1
  return Math.floor(draftState.value.current_pick_index / numPlayers.value) + 1
})

const totalRounds = computed(() => picksPerPlayer.value)

const currentPickUserId = computed(() => {
  if (!draftState.value) return null
  return draftState.value.draft_order[draftState.value.current_pick_index] ?? null
})

const currentPickUser = computed(() => {
  if (!currentPickUserId.value) return null
  return profiles.value.find(p => p.id === currentPickUserId.value) ?? null
})

const isMyTurn = computed(() => {
  return auth.user?.id === currentPickUserId.value && draftState.value?.status === 'drafting'
})

const profileMap = computed(() => {
  const map = new Map<string, Profile>()
  profiles.value.forEach(p => map.set(p.id, p))
  return map
})

const golferMap = computed(() => {
  const map = new Map<string, Golfer>()
  golfers.value.forEach(g => map.set(g.id, g))
  return map
})

const draftedGolferIds = computed(() => {
  return new Set(draftPicks.value.map(dp => dp.golfer_id))
})

const availableGolfers = computed(() => {
  return golfers.value
    .filter(g => !draftedGolferIds.value.has(g.id))
    .sort((a, b) => a.world_ranking - b.world_ranking)
})

const filteredGolfers = computed(() => {
  if (!searchQuery.value.trim()) return availableGolfers.value
  const q = searchQuery.value.toLowerCase().trim()
  return availableGolfers.value.filter(g =>
    g.name.toLowerCase().includes(q) ||
    g.country.toLowerCase().includes(q)
  )
})

const myPicks = computed(() => {
  if (!auth.user) return []
  return draftPicks.value
    .filter(dp => dp.user_id === auth.user!.id)
    .sort((a, b) => a.pick_number - b.pick_number)
    .map(dp => ({
      ...dp,
      golfer: golferMap.value.get(dp.golfer_id),
    }))
})

// Group picks and placeholders by round for the draft board
const draftBoard = computed(() => {
  if (!draftState.value || !numPlayers.value) return []
  const rounds: Array<{
    round: number
    reversed: boolean
    slots: Array<{
      pickNumber: number
      userId: string
      userName: string
      golfer: Golfer | null
      isCurrent: boolean
      isPicked: boolean
    }>
  }> = []

  const order = draftState.value.draft_order
  const pickMap = new Map<number, DraftPick>()
  draftPicks.value.forEach(dp => pickMap.set(dp.pick_number, dp))

  for (let r = 0; r < totalRounds.value; r++) {
    const reversed = r % 2 === 1
    const slots = []
    for (let s = 0; s < numPlayers.value; s++) {
      const pickIndex = r * numPlayers.value + s
      const userId = order[pickIndex]
      const pick = pickMap.get(pickIndex + 1) // pick_number is 1-based
      slots.push({
        pickNumber: pickIndex + 1,
        userId,
        userName: profileMap.value.get(userId)?.display_name ?? 'Unknown',
        golfer: pick ? golferMap.value.get(pick.golfer_id) ?? null : null,
        isCurrent: pickIndex === draftState.value!.current_pick_index && draftState.value!.status === 'drafting',
        isPicked: !!pick,
      })
    }
    rounds.push({ round: r + 1, reversed, slots })
  }

  return rounds
})

const timerDisplay = computed(() => {
  const mins = Math.floor(timerSeconds.value / 60)
  const secs = timerSeconds.value % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
})

const timerPercent = computed(() => {
  // Assume 90-second pick timer
  const totalTime = 90
  return Math.max(0, Math.min(100, (timerSeconds.value / totalTime) * 100))
})

// ─── Sound & Vibration ───

function playNotificationTone() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.setValueAtTime(1108, ctx.currentTime + 0.15)
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.3)

    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)

    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.5)
  } catch {
    // Web Audio not available, silently ignore
  }
}

function notifyMyTurn() {
  if (!draftState.value) return
  if (lastNotifiedPickIndex === draftState.value.current_pick_index) return
  lastNotifiedPickIndex = draftState.value.current_pick_index

  navigator.vibrate?.(200)
  playNotificationTone()
}

// ─── Timer ───

function startTimer() {
  stopTimer()
  updateTimer()
  timerInterval = setInterval(updateTimer, 1000)
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

function updateTimer() {
  if (!draftState.value?.pick_deadline) {
    timerSeconds.value = 0
    return
  }
  const deadline = new Date(draftState.value.pick_deadline).getTime()
  const now = Date.now()
  const diff = Math.max(0, Math.floor((deadline - now) / 1000))
  timerSeconds.value = diff

  if (diff <= 0 && draftState.value.status === 'drafting') {
    handleTimerExpired()
  }
}

async function handleTimerExpired() {
  if (!tournament.value || pickLoading.value) return
  // Only the current picker's client triggers auto_pick
  if (!isMyTurn.value) return
  stopTimer()
  try {
    await supabase.rpc('auto_pick', { p_tournament_id: tournament.value.id })
  } catch {
    // Server-side will handle if multiple clients attempt
  }
}

// ─── Actions ───

function selectGolfer(golfer: Golfer) {
  if (!isMyTurn.value) return
  selectedGolfer.value = golfer
}

async function confirmPick() {
  if (!selectedGolfer.value || !auth.user || !tournament.value || pickLoading.value) return
  pickLoading.value = true
  pickError.value = ''

  try {
    const { error } = await supabase.rpc('make_draft_pick', {
      p_tournament_id: tournament.value.id,
      p_user_id: auth.user.id,
      p_golfer_id: selectedGolfer.value.id,
    })
    if (error) throw error
    selectedGolfer.value = null
    searchQuery.value = ''
  } catch (err: any) {
    pickError.value = err.message ?? 'Failed to make pick'
  } finally {
    pickLoading.value = false
  }
}

function cancelSelection() {
  selectedGolfer.value = null
}

function countryFlag(country: string): string {
  const flags: Record<string, string> = {
    'USA': '\u{1F1FA}\u{1F1F8}', 'United States': '\u{1F1FA}\u{1F1F8}',
    'England': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    'Scotland': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    'Northern Ireland': '\u{1F3F4}\u{E0067}\u{E0062}\u{E006E}\u{E0069}\u{E0072}\u{E007F}',
    'Ireland': '\u{1F1EE}\u{1F1EA}',
    'Spain': '\u{1F1EA}\u{1F1F8}',
    'Japan': '\u{1F1EF}\u{1F1F5}',
    'Australia': '\u{1F1E6}\u{1F1FA}',
    'South Korea': '\u{1F1F0}\u{1F1F7}', 'Korea': '\u{1F1F0}\u{1F1F7}',
    'Sweden': '\u{1F1F8}\u{1F1EA}',
    'Norway': '\u{1F1F3}\u{1F1F4}',
    'Canada': '\u{1F1E8}\u{1F1E6}',
    'South Africa': '\u{1F1FF}\u{1F1E6}',
    'France': '\u{1F1EB}\u{1F1F7}',
    'Germany': '\u{1F1E9}\u{1F1EA}',
    'Italy': '\u{1F1EE}\u{1F1F9}',
    'Mexico': '\u{1F1F2}\u{1F1FD}',
    'Colombia': '\u{1F1E8}\u{1F1F4}',
    'Argentina': '\u{1F1E6}\u{1F1F7}',
    'Chile': '\u{1F1E8}\u{1F1F1}',
    'China': '\u{1F1E8}\u{1F1F3}',
    'Taiwan': '\u{1F1F9}\u{1F1FC}',
    'Thailand': '\u{1F1F9}\u{1F1ED}',
    'India': '\u{1F1EE}\u{1F1F3}',
    'Belgium': '\u{1F1E7}\u{1F1EA}',
    'Denmark': '\u{1F1E9}\u{1F1F0}',
    'Austria': '\u{1F1E6}\u{1F1F9}',
    'Finland': '\u{1F1EB}\u{1F1EE}',
    'New Zealand': '\u{1F1F3}\u{1F1FF}',
    'Philippines': '\u{1F1F5}\u{1F1ED}',
    'Zimbabwe': '\u{1F1FF}\u{1F1FC}',
  }
  return flags[country] ?? '\u{1F3CC}'
}

// ─── Data Fetching ───

async function fetchData() {
  loading.value = true

  const { data: t } = await supabase
    .from('tournaments')
    .select('*')
    .eq('year', 2026)
    .single()

  tournament.value = t
  if (!t) {
    loading.value = false
    return
  }

  const [draftRes, picksRes, golfersRes, profilesRes] = await Promise.all([
    supabase.from('draft_state').select('*').eq('tournament_id', t.id).single(),
    supabase.from('draft_picks').select('*').eq('tournament_id', t.id),
    supabase.from('golfers').select('*').eq('is_active', true),
    supabase.from('profiles').select('*'),
  ])

  draftState.value = draftRes.data as unknown as DraftState | null
  draftPicks.value = picksRes.data ?? []
  golfers.value = golfersRes.data ?? []
  profiles.value = profilesRes.data ?? []

  loading.value = false
}

// ─── Realtime ───

function setupRealtimeSubscriptions() {
  if (!tournament.value) return

  const draftStateChannel = supabase
    .channel('draft-view-state')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_state', filter: `tournament_id=eq.${tournament.value.id}` },
      (payload) => {
        draftState.value = payload.new as unknown as DraftState
      }
    )
    .subscribe()
  channels.push(draftStateChannel)

  const draftPicksChannel = supabase
    .channel('draft-view-picks')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'draft_picks', filter: `tournament_id=eq.${tournament.value.id}` },
      (payload) => {
        const newPick = payload.new as DraftPick
        // Avoid duplicates
        if (!draftPicks.value.find(dp => dp.id === newPick.id)) {
          draftPicks.value.push(newPick)
        }
        // Clear selection if someone else picked the golfer we had selected
        if (selectedGolfer.value && newPick.golfer_id === selectedGolfer.value.id) {
          selectedGolfer.value = null
        }
      }
    )
    .subscribe()
  channels.push(draftPicksChannel)
}

function cleanup() {
  stopTimer()
  channels.forEach(ch => supabase.removeChannel(ch))
  channels.length = 0
}

// Watch for turn changes
watch(isMyTurn, (val) => {
  if (val) {
    notifyMyTurn()
    // Scroll to top so pick interface is visible
    nextTick(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }
})

// Watch draft state to manage timer
watch(draftState, (val) => {
  if (val?.status === 'drafting' && val.pick_deadline) {
    startTimer()
  } else {
    stopTimer()
    timerSeconds.value = 0
  }
}, { deep: true })

onMounted(async () => {
  await fetchData()
  setupRealtimeSubscriptions()
  if (draftState.value?.status === 'drafting' && draftState.value.pick_deadline) {
    startTimer()
  }
  // If it's already our turn on mount, notify
  if (isMyTurn.value) {
    notifyMyTurn()
  }
})

onUnmounted(() => {
  cleanup()
})
</script>

<template>
  <div class="p-4 max-w-lg mx-auto space-y-4 pb-8">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <!-- ==================== WAITING ==================== -->
    <template v-else-if="!draftState || draftState.status === 'waiting'">
      <div class="text-center py-16 space-y-4">
        <div class="bg-augusta-gradient rounded-2xl p-8 shadow-lg">
          <h1 class="text-2xl font-bold text-gold-glow tracking-wider">THE MORRISON OPEN DRAFT</h1>
          <p class="text-cream/80 mt-3 text-sm">Waiting for the draft to begin...</p>
          <div class="mt-6">
            <div class="animate-pulse flex justify-center gap-2">
              <span class="w-2.5 h-2.5 bg-gold rounded-full"></span>
              <span class="w-2.5 h-2.5 bg-gold rounded-full animation-delay-200"></span>
              <span class="w-2.5 h-2.5 bg-gold rounded-full animation-delay-400"></span>
            </div>
          </div>
        </div>
        <router-link
          to="/dashboard"
          class="inline-block text-augusta font-semibold text-sm hover:underline"
        >
          &larr; Back to Dashboard
        </router-link>
      </div>
    </template>

    <!-- ==================== DRAFTING ==================== -->
    <template v-else-if="draftState.status === 'drafting'">
      <!-- Draft Header -->
      <div class="bg-augusta-gradient rounded-2xl p-4 shadow-lg text-center">
        <h1 class="text-xl font-bold text-gold-glow tracking-wider">THE MORRISON OPEN DRAFT</h1>
        <p class="text-cream/70 text-sm mt-1">
          Round {{ currentRound }} of {{ totalRounds }}
          &middot; Pick {{ draftState.current_pick_index + 1 }} of {{ totalPicks }}
        </p>
      </div>

      <!-- Timer Section -->
      <div
        class="rounded-2xl p-5 shadow-md text-center"
        :class="isMyTurn ? 'bg-green-50 border-2 border-green-400' : 'bg-white'"
      >
        <!-- Whose turn -->
        <p v-if="isMyTurn" class="text-green-600 font-bold text-lg uppercase tracking-wide animate-pulse">
          YOUR PICK!
        </p>
        <p v-else class="text-gray-500 text-sm font-medium">
          {{ currentPickUser?.display_name ?? 'Unknown' }}'s Pick
        </p>

        <!-- Timer display -->
        <div class="mt-3">
          <span
            class="text-5xl font-bold font-score"
            :class="timerSeconds <= 10 ? 'text-red-600 animate-pulse' : isMyTurn ? 'text-green-700' : 'text-dark'"
          >
            {{ timerDisplay }}
          </span>
        </div>

        <!-- Timer bar -->
        <div class="mt-4 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-1000 ease-linear"
            :class="timerPercent <= 20 ? 'bg-red-500' : timerPercent <= 50 ? 'bg-yellow-500' : 'bg-green-500'"
            :style="{ width: timerPercent + '%' }"
          ></div>
        </div>
      </div>

      <!-- Pick Interface -->
      <div class="bg-white rounded-2xl shadow-md overflow-hidden">
        <!-- Selected golfer confirmation -->
        <div v-if="selectedGolfer && isMyTurn" class="p-4 bg-gold/10 border-b border-gold/30">
          <p class="text-sm text-gray-500 mb-2">Confirm your pick:</p>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <span class="text-2xl">{{ countryFlag(selectedGolfer.country) }}</span>
              <div>
                <p class="font-bold text-dark text-lg">{{ selectedGolfer.name }}</p>
                <p class="text-gray-400 text-xs">
                  #{{ selectedGolfer.world_ranking }} &middot; {{ selectedGolfer.odds ?? '--' }}
                </p>
              </div>
            </div>
            <button
              @click="cancelSelection"
              class="text-gray-400 hover:text-gray-600 text-xl px-2"
              :disabled="pickLoading"
            >
              &#10005;
            </button>
          </div>
          <button
            @click="confirmPick"
            :disabled="pickLoading"
            class="w-full mt-3 py-3 rounded-xl font-bold text-white text-lg bg-augusta-gradient shadow-md active:scale-95 transition-transform disabled:opacity-50"
          >
            <span v-if="pickLoading" class="animate-pulse">Picking...</span>
            <span v-else>Confirm Pick: {{ selectedGolfer.name }}</span>
          </button>
          <p v-if="pickError" class="text-red-500 text-sm mt-2 text-center">{{ pickError }}</p>
        </div>

        <!-- Header + Search -->
        <div class="p-4 border-b border-gray-100">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-bold text-dark text-lg">
              {{ isMyTurn ? 'Select a Golfer' : 'Available Golfers' }}
            </h2>
            <span class="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
              {{ availableGolfers.length }} left
            </span>
          </div>
          <div class="relative">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Search golfers..."
              class="w-full pl-9 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-dark text-sm focus:outline-none focus:ring-2 focus:ring-augusta/30 focus:border-augusta"
            />
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
          </div>
          <p v-if="!isMyTurn" class="text-gray-400 text-xs mt-2 italic">
            Waiting for {{ currentPickUser?.display_name ?? 'Unknown' }} to pick...
          </p>
        </div>

        <!-- Golfer list -->
        <div class="max-h-80 overflow-y-auto divide-y divide-gray-50">
          <div v-if="filteredGolfers.length === 0" class="p-6 text-center text-gray-400 text-sm">
            No golfers match your search.
          </div>
          <button
            v-for="golfer in filteredGolfers"
            :key="golfer.id"
            @click="selectGolfer(golfer)"
            :disabled="!isMyTurn || pickLoading"
            class="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
            :class="[
              isMyTurn ? 'hover:bg-augusta/5 active:bg-augusta/10 cursor-pointer' : 'cursor-default',
              selectedGolfer?.id === golfer.id ? 'bg-gold/10' : '',
            ]"
          >
            <span class="text-lg flex-shrink-0">{{ countryFlag(golfer.country) }}</span>
            <div class="flex-1 min-w-0">
              <p class="font-medium text-dark text-sm truncate">{{ golfer.name }}</p>
              <p class="text-gray-400 text-xs">{{ golfer.country }}</p>
            </div>
            <div class="text-right flex-shrink-0">
              <p class="text-xs font-bold text-dark">#{{ golfer.world_ranking }}</p>
              <p class="text-xs text-gray-400">{{ golfer.odds ?? '--' }}</p>
            </div>
          </button>
        </div>
      </div>

      <!-- Draft Board -->
      <div class="bg-white rounded-2xl shadow-md p-4">
        <h2 class="font-bold text-dark text-lg mb-3">Draft Board</h2>
        <div class="space-y-4">
          <div v-for="round in draftBoard" :key="round.round">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-xs font-bold text-augusta uppercase tracking-wide">Round {{ round.round }}</span>
              <span v-if="round.reversed" class="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                &#8635; Snake
              </span>
              <div class="flex-1 border-t border-gray-100"></div>
            </div>
            <div class="space-y-1.5">
              <div
                v-for="slot in round.slots"
                :key="slot.pickNumber"
                class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
                :class="[
                  slot.isCurrent ? 'bg-green-50 border border-green-300 animate-pulse' : '',
                  slot.isPicked ? 'bg-gray-50' : '',
                  !slot.isPicked && !slot.isCurrent ? 'bg-gray-50/50' : '',
                ]"
              >
                <span class="w-6 text-center text-xs font-bold font-score text-gray-400">
                  {{ slot.pickNumber }}
                </span>
                <span class="w-24 truncate font-medium" :class="slot.isCurrent ? 'text-green-700' : 'text-dark'">
                  {{ slot.userName }}
                </span>
                <span class="flex-1 text-right truncate" :class="slot.isPicked ? 'text-dark font-medium' : 'text-gray-300'">
                  {{ slot.golfer ? slot.golfer.name : (slot.isCurrent ? '...' : '--') }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Your Team Summary -->
      <div class="bg-white rounded-2xl shadow-md p-4">
        <h2 class="font-bold text-dark text-lg mb-3">Your Team</h2>
        <div v-if="myPicks.length === 0" class="text-gray-400 text-sm text-center py-4">
          No picks yet
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="(pick, idx) in myPicks"
            :key="pick.id"
            class="flex items-center gap-3 px-3 py-2 bg-augusta/5 rounded-xl"
          >
            <span class="text-sm font-bold font-score text-augusta w-6 text-center">{{ idx + 1 }}</span>
            <span class="text-lg">{{ pick.golfer ? countryFlag(pick.golfer.country) : '' }}</span>
            <span class="font-medium text-dark text-sm">{{ pick.golfer?.name ?? 'Unknown' }}</span>
            <span class="ml-auto text-xs text-gray-400">#{{ pick.golfer?.world_ranking ?? '--' }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== COMPLETED ==================== -->
    <template v-else-if="draftState.status === 'completed'">
      <div class="bg-augusta-gradient rounded-2xl p-6 shadow-lg text-center">
        <h1 class="text-2xl font-bold text-gold-glow tracking-wider">DRAFT COMPLETE!</h1>
        <p class="text-cream/80 mt-2 text-sm">All picks are in. Good luck!</p>
      </div>

      <!-- Full Draft Recap by Round -->
      <div class="bg-white rounded-2xl shadow-md p-4">
        <h2 class="font-bold text-dark text-lg mb-3">Draft Recap</h2>
        <div class="space-y-4">
          <div v-for="round in draftBoard" :key="round.round">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-xs font-bold text-augusta uppercase tracking-wide">Round {{ round.round }}</span>
              <span v-if="round.reversed" class="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                &#8635; Snake
              </span>
              <div class="flex-1 border-t border-gray-100"></div>
            </div>
            <div class="space-y-1.5">
              <div
                v-for="slot in round.slots"
                :key="slot.pickNumber"
                class="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 text-sm"
                :class="slot.userId === auth.user?.id ? 'ring-1 ring-augusta/30 bg-augusta/5' : ''"
              >
                <span class="w-6 text-center text-xs font-bold font-score text-gray-400">
                  {{ slot.pickNumber }}
                </span>
                <span class="w-24 truncate font-medium text-dark">
                  {{ slot.userName }}
                  <span v-if="slot.userId === auth.user?.id" class="text-[10px] text-augusta ml-0.5">(You)</span>
                </span>
                <span class="flex-1 text-right truncate font-medium text-dark">
                  {{ slot.golfer?.name ?? '--' }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Your Final Team -->
      <div class="bg-white rounded-2xl shadow-md p-4">
        <h2 class="font-bold text-dark text-lg mb-3">Your Team</h2>
        <div class="space-y-2">
          <div
            v-for="(pick, idx) in myPicks"
            :key="pick.id"
            class="flex items-center gap-3 px-3 py-2.5 bg-augusta/5 rounded-xl"
          >
            <span class="text-sm font-bold font-score text-augusta w-6 text-center">{{ idx + 1 }}</span>
            <span class="text-lg">{{ pick.golfer ? countryFlag(pick.golfer.country) : '' }}</span>
            <div class="flex-1">
              <p class="font-medium text-dark text-sm">{{ pick.golfer?.name ?? 'Unknown' }}</p>
              <p class="text-gray-400 text-xs">#{{ pick.golfer?.world_ranking ?? '--' }} &middot; {{ pick.golfer?.odds ?? '--' }}</p>
            </div>
          </div>
        </div>
      </div>

      <router-link
        to="/my-team"
        class="block w-full py-4 rounded-xl font-bold text-white text-lg text-center bg-augusta-gradient shadow-lg active:scale-95 transition-transform"
      >
        View My Team &rarr;
      </router-link>
    </template>
  </div>
</template>

<style scoped>
.animation-delay-200 {
  animation-delay: 0.2s;
}
.animation-delay-400 {
  animation-delay: 0.4s;
}
</style>
