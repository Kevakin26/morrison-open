<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'

import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Tournament = Database['public']['Tables']['tournaments']['Row']
type ReadyCheck = Database['public']['Tables']['ready_checks']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']
type DraftPick = Database['public']['Tables']['draft_picks']['Row']
type GolferScore = Database['public']['Tables']['golfer_scores']['Row']
type Golfer = Database['public']['Tables']['golfers']['Row']

interface DraftState {
  id: string
  tournament_id: string
  status: string
  draft_order: string[]
  current_pick_index: number
  pick_deadline: string | null
  created_at: string
}

const auth = useAuthStore()

const tournament = ref<Tournament | null>(null)
const draftState = ref<DraftState | null>(null)
const readyChecks = ref<ReadyCheck[]>([])
const profiles = ref<Profile[]>([])
const golferCount = ref(0)
const loading = ref(true)
const togglingReady = ref(false)

// In-progress / completed state
const draftPicks = ref<DraftPick[]>([])
const golferScores = ref<GolferScore[]>([])
const golfers = ref<Golfer[]>([])


// Countdown
const countdown = ref({ days: 0, hours: 0, minutes: 0, seconds: 0 })
let countdownInterval: ReturnType<typeof setInterval> | null = null

// Realtime channels
const channels: RealtimeChannel[] = []

const DRAFT_DATE = new Date('2026-04-07T01:00:00Z') // April 6, 6:00 PM MST (UTC-7)

const tournamentStatus = computed(() => tournament.value?.status ?? 'pre-draft')

const currentUserReady = computed(() => {
  if (!auth.user) return false
  return readyChecks.value.find(rc => rc.user_id === auth.user!.id)?.is_ready ?? false
})

const notReadyPlayers = computed(() => {
  const readyIds = new Set(
    readyChecks.value.filter(rc => rc.is_ready).map(rc => rc.user_id)
  )
  return profiles.value.filter(p => !readyIds.has(p.id))
})

const isPlayerReady = (playerId: string) => {
  return readyChecks.value.find(rc => rc.user_id === playerId)?.is_ready ?? false
}

// In-progress helpers
const currentPickUser = computed(() => {
  if (!draftState.value || draftState.value.status !== 'drafting') return null
  const userId = draftState.value.draft_order[draftState.value.current_pick_index]
  return profiles.value.find(p => p.id === userId)
})

const userPicks = computed(() => {
  if (!auth.user) return []
  return draftPicks.value
    .filter(dp => dp.user_id === auth.user!.id)
    .map(dp => {
      const golfer = golfers.value.find(g => g.id === dp.golfer_id)
      const score = golferScores.value.find(gs => gs.golfer_id === dp.golfer_id)
      return { ...dp, golfer, score }
    })
})

const playerStandings = computed(() => {
  const standingsMap = new Map<string, { userId: string; name: string; totalToPar: number | null }>()

  for (const profile of profiles.value) {
    // Get this player's picks
    const playerPicks = draftPicks.value.filter(dp => dp.user_id === profile.id)
    // Get scores for active golfers only
    const activeScores = playerPicks
      .map(pick => golferScores.value.find(gs => gs.golfer_id === pick.golfer_id))
      .filter(score => score && (score.status === 'active' || score.to_par == null))
      .filter(score => score?.to_par != null)
      .sort((a, b) => a!.to_par! - b!.to_par!)

    // Best 2 of active golfers
    const best2 = activeScores.slice(0, 2)
    const total = best2.length > 0 ? best2.reduce((sum, s) => sum + s!.to_par!, 0) : null

    standingsMap.set(profile.id, { userId: profile.id, name: profile.display_name, totalToPar: total })
  }

  return Array.from(standingsMap.values()).sort((a, b) => (a.totalToPar ?? 999) - (b.totalToPar ?? 999))
})

const topThree = computed(() => playerStandings.value.slice(0, 3))
const winner = computed(() => playerStandings.value[0] ?? null)

function formatScore(toPar: number | null): string {
  if (toPar == null) return '--'
  if (toPar === 0) return 'E'
  return toPar > 0 ? `+${toPar}` : `${toPar}`
}

function updateCountdown() {
  const now = new Date().getTime()
  const target = DRAFT_DATE.getTime()
  const diff = target - now

  if (diff <= 0) {
    countdown.value = { days: 0, hours: 0, minutes: 0, seconds: 0 }
    return
  }

  countdown.value = {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((diff % (1000 * 60)) / 1000),
  }
}

const startingDraft = ref(false)

const allReady = computed(() => {
  if (profiles.value.length === 0) return false
  return profiles.value.every(p =>
    readyChecks.value.some(rc => rc.user_id === p.id && rc.is_ready)
  )
})

async function toggleReady() {
  if (!auth.user || !tournament.value || togglingReady.value) return
  togglingReady.value = true

  try {
    await supabase.from('ready_checks').upsert(
      {
        tournament_id: tournament.value.id,
        user_id: auth.user.id,
        is_ready: !currentUserReady.value,
      },
      { onConflict: 'tournament_id,user_id' }
    )

    // Check if all players are now ready — auto-start
    const newReady = !currentUserReady.value
    if (newReady) {
      const { data: checks } = await supabase
        .from('ready_checks')
        .select('*')
        .eq('tournament_id', tournament.value.id)

      const { data: allProfiles } = await supabase.from('profiles').select('id')

      if (checks && allProfiles) {
        const everyoneReady = allProfiles.every(p =>
          checks.some(c => c.user_id === p.id && c.is_ready)
        )
        if (everyoneReady && allProfiles.length >= 1) {
          await startDraft()
        }
      }
    }
  } finally {
    togglingReady.value = false
  }
}

async function startDraft() {
  if (!tournament.value || startingDraft.value) return
  startingDraft.value = true
  try {
    const { error } = await supabase.rpc('start_draft', {
      p_tournament_id: tournament.value.id,
    })
    if (error) {
      console.error('Failed to start draft:', error)
      alert('Failed to start draft: ' + error.message)
    }
  } finally {
    startingDraft.value = false
  }
}

async function fetchData() {
  loading.value = true

  // Fetch tournament
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

  // Parallel fetches
  const [draftRes, readyRes, profilesRes, golferCountRes] = await Promise.all([
    supabase.from('draft_state').select('*').eq('tournament_id', t.id).single(),
    supabase.from('ready_checks').select('*').eq('tournament_id', t.id),
    supabase.from('profiles').select('*'),
    supabase.from('golfers').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ])

  draftState.value = draftRes.data as unknown as DraftState | null
  readyChecks.value = readyRes.data ?? []
  profiles.value = profilesRes.data ?? []
  golferCount.value = golferCountRes.count ?? 0

  // Fetch additional data for in-progress / completed states
  if (t.status === 'in-progress' || t.status === 'completed') {
    const [picksRes, scoresRes, golfersRes] = await Promise.all([
      supabase.from('draft_picks').select('*').eq('tournament_id', t.id),
      supabase.from('golfer_scores').select('*').eq('tournament_id', t.id),
      supabase.from('golfers').select('*').eq('is_active', true),
    ])
    draftPicks.value = picksRes.data ?? []
    golferScores.value = scoresRes.data ?? []
    golfers.value = golfersRes.data ?? []
  }

  loading.value = false
}

function setupRealtimeSubscriptions() {
  if (!tournament.value) return

  const tournamentChannel = supabase
    .channel('dashboard-tournaments')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${tournament.value.id}` },
      (payload) => {
        tournament.value = payload.new as Tournament
      }
    )
    .subscribe()
  channels.push(tournamentChannel)

  const draftChannel = supabase
    .channel('dashboard-draft-state')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_state', filter: `tournament_id=eq.${tournament.value.id}` },
      (payload) => {
        draftState.value = payload.new as DraftState
      }
    )
    .subscribe()
  channels.push(draftChannel)

  const readyChannel = supabase
    .channel('dashboard-ready-checks')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ready_checks', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        // Re-fetch all ready checks on any change
        const { data } = await supabase
          .from('ready_checks')
          .select('*')
          .eq('tournament_id', tournament.value!.id)
        readyChecks.value = data ?? []
      }
    )
    .subscribe()
  channels.push(readyChannel)

  // Score updates for in-progress
  const scoresChannel = supabase
    .channel('dashboard-scores')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'golfer_scores', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        const { data } = await supabase
          .from('golfer_scores')
          .select('*')
          .eq('tournament_id', tournament.value!.id)
        golferScores.value = data ?? []
      }
    )
    .subscribe()
  channels.push(scoresChannel)
}

function cleanup() {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
  channels.forEach(ch => supabase.removeChannel(ch))
  channels.length = 0
}

onMounted(async () => {
  await fetchData()
  setupRealtimeSubscriptions()
  updateCountdown()
  countdownInterval = setInterval(updateCountdown, 1000)
})

onUnmounted(() => {
  cleanup()
})
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-8 max-w-lg md:max-w-2xl mx-auto space-y-6 pb-24">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <!-- ==================== PRE-DRAFT ==================== -->
    <template v-else-if="tournamentStatus === 'pre-draft'">
      <!-- Welcome -->
      <div class="text-center pt-4">
        <h1 class="text-2xl font-bold text-dark">
          Welcome, {{ auth.displayName }}!
        </h1>
        <p class="text-gray-500 mt-1 text-sm">The Morrison Open 2026</p>
      </div>

      <!-- Countdown -->
      <div class="bg-augusta-gradient rounded-2xl p-6 text-center shadow-lg">
        <p class="text-cream/80 text-sm font-medium uppercase tracking-wide mb-3">Draft Night Countdown</p>
        <div class="flex justify-center gap-2 sm:gap-3">
          <div v-for="(val, key) in countdown" :key="key" class="bg-black/30 rounded-xl px-3 py-3 sm:px-4 sm:py-4 min-w-[56px] sm:min-w-[68px]">
            <span class="text-2xl sm:text-3xl font-bold text-gold-glow font-score">{{ String(val).padStart(2, '0') }}</span>
            <p class="text-cream/60 text-[10px] uppercase mt-1">{{ key }}</p>
          </div>
        </div>
        <p class="text-cream mt-4 text-sm font-medium">
          Monday, April 6 &middot; 6:00 PM MST
        </p>
      </div>

      <!-- Player Ready Status -->
      <div class="bg-white rounded-2xl shadow-md p-5">
        <h2 class="font-bold text-dark text-lg mb-3">Players</h2>
        <ul class="space-y-2.5">
          <li
            v-for="profile in profiles"
            :key="profile.id"
            class="flex items-center gap-3"
          >
            <span
              class="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm"
              :class="isPlayerReady(profile.id) ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'"
            >
              <template v-if="isPlayerReady(profile.id)">&#10003;</template>
              <template v-else>&#9675;</template>
            </span>
            <span class="text-dark font-medium">{{ profile.display_name }}</span>
            <span
              v-if="profile.id === auth.user?.id"
              class="text-[10px] bg-augusta/10 text-augusta px-2 py-0.5 rounded-full font-semibold uppercase"
            >
              You
            </span>
          </li>
        </ul>

        <p v-if="notReadyPlayers.length > 0" class="text-gray-400 text-sm mt-3">
          Waiting for: {{ notReadyPlayers.map(p => p.display_name).join(', ') }}
        </p>
        <p v-else class="text-green-600 text-sm mt-3 font-medium">
          All players ready!
        </p>
      </div>

      <!-- Ready Toggle -->
      <button
        @click="toggleReady"
        :disabled="togglingReady"
        class="w-full py-3.5 min-h-[48px] rounded-xl font-bold text-white text-lg transition-all active:scale-95"
        :class="currentUserReady
          ? 'bg-green-500 shadow-md shadow-green-500/30'
          : 'bg-gray-400 shadow-md shadow-gray-400/30'"
      >
        <span v-if="togglingReady" class="animate-pulse">Updating...</span>
        <span v-else>{{ currentUserReady ? "I'm Ready! &#10003;" : "I'm Ready" }}</span>
      </button>

      <!-- Manual Start Draft (when all ready) -->
      <button
        v-if="allReady && profiles.length >= 1"
        @click="startDraft"
        :disabled="startingDraft"
        class="w-full py-3.5 rounded-xl font-bold text-white text-lg bg-augusta-gradient shadow-lg active:scale-95 transition-all"
      >
        <span v-if="startingDraft" class="animate-pulse">Starting Draft...</span>
        <span v-else>Start the Draft!</span>
      </button>

      <!-- Golfer Field Link -->
      <div class="bg-white rounded-2xl shadow-md p-5 flex items-center justify-between">
        <div>
          <p class="text-dark font-bold">{{ golferCount }} golfers in the field</p>
          <p class="text-gray-400 text-sm">View the full field and stats</p>
        </div>
        <router-link
          to="/golfers"
          class="text-augusta font-semibold text-sm hover:underline whitespace-nowrap"
        >
          View Golfer Field &rarr;
        </router-link>
      </div>
    </template>

    <!-- ==================== DRAFT ==================== -->
    <template v-else-if="tournamentStatus === 'draft'">
      <div class="text-center pt-6">
        <div class="inline-block bg-augusta-gradient rounded-2xl px-8 py-6 shadow-lg">
          <h1 class="text-3xl font-bold text-gold-glow animate-pulse font-score tracking-wider">
            DRAFT IN PROGRESS!
          </h1>
        </div>
      </div>

      <div v-if="currentPickUser" class="bg-white rounded-2xl shadow-md p-5 text-center">
        <p class="text-gray-500 text-sm">Currently picking</p>
        <p class="text-dark text-xl font-bold mt-1">{{ currentPickUser.display_name }}</p>
        <p class="text-gray-400 text-sm mt-1">
          Pick {{ (draftState?.current_pick_index ?? 0) + 1 }} of {{ draftState?.draft_order?.length ?? 0 }}
        </p>
      </div>

      <router-link
        to="/draft"
        class="block w-full py-4 rounded-xl font-bold text-white text-lg text-center bg-augusta-gradient shadow-lg active:scale-95 transition-transform"
      >
        Join the Draft &rarr;
      </router-link>
    </template>

    <!-- ==================== IN PROGRESS ==================== -->
    <template v-else-if="tournamentStatus === 'in-progress'">
      <div class="text-center pt-4">
        <h1 class="text-2xl font-bold text-dark">
          The Masters &ndash; Round {{ tournament?.current_round ?? '?' }}
        </h1>
        <p class="text-gray-500 text-sm mt-1">The Morrison Open 2026</p>
      </div>

      <!-- Mini Leaderboard -->
      <div class="bg-white rounded-2xl shadow-md p-5">
        <h2 class="font-bold text-dark text-lg mb-3">Leaderboard</h2>
        <div class="space-y-2">
          <div
            v-for="(standing, idx) in topThree"
            :key="standing.userId"
            class="flex items-center justify-between py-2 px-3 rounded-xl"
            :class="idx === 0 ? 'bg-gold/10' : 'bg-gray-50'"
          >
            <div class="flex items-center gap-3">
              <span class="text-lg font-bold font-score" :class="idx === 0 ? 'text-gold' : 'text-gray-400'">
                {{ idx + 1 }}
              </span>
              <span class="font-medium text-dark">{{ standing.name }}</span>
            </div>
            <span
              class="font-bold font-score"
              :class="(standing.totalToPar ?? 0) < 0 ? 'text-red-600' : (standing.totalToPar ?? 0) > 0 ? 'text-gray-600' : 'text-dark'"
            >
              {{ formatScore(standing.totalToPar) }}
            </span>
          </div>
        </div>
        <router-link
          to="/leaderboard"
          class="block text-center text-augusta font-semibold text-sm mt-4 hover:underline"
        >
          See Full Leaderboard &rarr;
        </router-link>
      </div>

      <!-- Your Team -->
      <div class="bg-white rounded-2xl shadow-md p-5">
        <h2 class="font-bold text-dark text-lg mb-3">Your Team</h2>
        <div v-if="userPicks.length === 0" class="text-gray-400 text-sm">
          No picks found.
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="pick in userPicks"
            :key="pick.id"
            class="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-xl"
          >
            <div>
              <p class="font-medium text-dark">{{ pick.golfer?.name ?? 'Unknown' }}</p>
              <p class="text-xs text-gray-400">{{ pick.score?.position ?? '--' }} &middot; Thru {{ pick.score?.thru ?? '--' }}</p>
            </div>
            <span
              class="font-bold font-score"
              :class="(pick.score?.to_par ?? 0) < 0 ? 'text-red-600' : (pick.score?.to_par ?? 0) > 0 ? 'text-gray-600' : 'text-dark'"
            >
              {{ pick.score?.to_par != null ? formatScore(pick.score.to_par) : '--' }}
            </span>
          </div>
        </div>
        <router-link
          to="/my-team"
          class="block text-center text-augusta font-semibold text-sm mt-4 hover:underline"
        >
          View Full Team &rarr;
        </router-link>
      </div>
    </template>

    <!-- ==================== COMPLETED ==================== -->
    <template v-else-if="tournamentStatus === 'completed'">
      <div class="text-center pt-6 space-y-2">
        <p class="text-4xl">&#127942;</p>
        <h1 class="text-2xl font-bold text-dark">
          Winner: {{ winner?.name ?? 'TBD' }}
        </h1>
        <p v-if="winner" class="text-augusta font-bold font-score text-xl">
          {{ formatScore(winner.totalToPar) }}
        </p>
      </div>

      <!-- Final Standings -->
      <div class="bg-white rounded-2xl shadow-md p-5">
        <h2 class="font-bold text-dark text-lg mb-3">Final Standings</h2>
        <div class="space-y-2">
          <div
            v-for="(standing, idx) in playerStandings"
            :key="standing.userId"
            class="flex items-center justify-between py-2 px-3 rounded-xl"
            :class="idx === 0 ? 'bg-gold/10' : 'bg-gray-50'"
          >
            <div class="flex items-center gap-3">
              <span class="text-lg font-bold font-score" :class="idx === 0 ? 'text-gold' : 'text-gray-400'">
                {{ idx + 1 }}
              </span>
              <span class="font-medium text-dark">{{ standing.name }}</span>
            </div>
            <span
              class="font-bold font-score"
              :class="(standing.totalToPar ?? 0) < 0 ? 'text-red-600' : (standing.totalToPar ?? 0) > 0 ? 'text-gray-600' : 'text-dark'"
            >
              {{ formatScore(standing.totalToPar) }}
            </span>
          </div>
        </div>
      </div>

      <router-link
        to="/leaderboard"
        class="block w-full py-4 rounded-xl font-bold text-white text-lg text-center bg-augusta-gradient shadow-lg active:scale-95 transition-transform"
      >
        See Full Results &rarr;
      </router-link>
    </template>
  </div>
</template>
