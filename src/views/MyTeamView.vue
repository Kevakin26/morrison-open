<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Tournament = Database['public']['Tables']['tournaments']['Row']
type DraftPick = Database['public']['Tables']['draft_picks']['Row']
type Golfer = Database['public']['Tables']['golfers']['Row']
type GolferScore = Database['public']['Tables']['golfer_scores']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']

interface TeamGolfer {
  pick: DraftPick
  golfer: Golfer
  score: GolferScore | null
  counting: boolean
}

const auth = useAuthStore()

const tournament = ref<Tournament | null>(null)
const draftPicks = ref<DraftPick[]>([])
const golfers = ref<Golfer[]>([])
const golferScores = ref<GolferScore[]>([])
const allDraftPicks = ref<DraftPick[]>([])
const profiles = ref<Profile[]>([])
const loading = ref(true)

let channel: RealtimeChannel | null = null

const tournamentStarted = computed(() => {
  const s = tournament.value?.status
  return s === 'in-progress' || s === 'completed'
})

function formatToPar(n: number | null): string {
  if (n == null) return '--'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : `${n}`
}

function formatToday(today: number | null, thru: string | null): string {
  if (today == null || thru == null) return '--'
  return `${formatToPar(today)} thru ${thru}`
}

function isActive(score: GolferScore | null): boolean {
  if (!score) return true // no score yet means hasn't been cut
  return score.status === 'active'
}

function isCut(score: GolferScore | null): boolean {
  return score?.status === 'cut'
}

function isWithdrawn(score: GolferScore | null): boolean {
  return score?.status === 'withdrawn' || score?.status === 'wd'
}

function isDQ(score: GolferScore | null): boolean {
  return score?.status === 'dq' || score?.status === 'disqualified'
}

function statusLabel(score: GolferScore | null): string {
  if (!score) return 'Active'
  const s = score.status.toLowerCase()
  if (s === 'active') return 'Active'
  if (s === 'cut') return 'CUT'
  if (s === 'withdrawn' || s === 'wd') return 'WD'
  if (s === 'dq' || s === 'disqualified') return 'DQ'
  return score.status.toUpperCase()
}

function statusColor(score: GolferScore | null): string {
  if (!score || score.status === 'active') return 'bg-green-500'
  if (score.status === 'cut') return 'bg-red-500'
  if (score.status === 'withdrawn' || score.status === 'wd') return 'bg-orange-500'
  return 'bg-red-500'
}

const teamGolfers = computed<TeamGolfer[]>(() => {
  const picks = draftPicks.value.map(pick => {
    const golfer = golfers.value.find(g => g.id === pick.golfer_id)
    const score = golferScores.value.find(gs => gs.golfer_id === pick.golfer_id) ?? null
    return { pick, golfer: golfer!, score, counting: false }
  }).filter(tg => tg.golfer)

  if (!tournamentStarted.value) return picks

  // Separate active vs inactive
  const active = picks.filter(tg => isActive(tg.score))
  const inactive = picks.filter(tg => !isActive(tg.score))

  // Sort active by to_par ascending (best first)
  active.sort((a, b) => {
    const aScore = a.score?.to_par ?? 999
    const bScore = b.score?.to_par ?? 999
    return aScore - bScore
  })

  // Best 2 active golfers count
  active.forEach((tg, idx) => {
    tg.counting = idx < 2
  })

  return [...active, ...inactive]
})

const countingGolfers = computed(() => teamGolfers.value.filter(tg => tg.counting))

const combinedScore = computed<number | null>(() => {
  const counting = countingGolfers.value
  if (counting.length === 0) return null
  let total = 0
  for (const tg of counting) {
    if (tg.score?.to_par != null) {
      total += tg.score.to_par
    }
  }
  return total
})

const activeCount = computed(() =>
  teamGolfers.value.filter(tg => isActive(tg.score)).length
)

const isEliminated = computed(() => activeCount.value < 2)

// Calculate rank among all players
const currentRank = computed<string>(() => {
  if (!auth.user || !tournamentStarted.value) return '--'

  // Build standings for all players
  const playerScores = new Map<string, number | null>()

  // Group picks by user
  const picksByUser = new Map<string, DraftPick[]>()
  for (const pick of allDraftPicks.value) {
    if (!picksByUser.has(pick.user_id)) picksByUser.set(pick.user_id, [])
    picksByUser.get(pick.user_id)!.push(pick)
  }

  for (const [userId, picks] of picksByUser) {
    const scores = picks
      .map(p => golferScores.value.find(gs => gs.golfer_id === p.golfer_id))
      .filter(s => s && isActive(s))
      .sort((a, b) => (a!.to_par ?? 999) - (b!.to_par ?? 999))

    if (scores.length < 2) {
      playerScores.set(userId, null) // eliminated
    } else {
      const best2 = scores.slice(0, 2)
      const total = best2.reduce((sum, s) => sum + (s!.to_par ?? 0), 0)
      playerScores.set(userId, total)
    }
  }

  // Sort players (null = eliminated, goes to bottom)
  const sorted = Array.from(playerScores.entries())
    .filter(([, score]) => score !== null)
    .sort((a, b) => a[1]! - b[1]!)

  const myScore = playerScores.get(auth.user.id)
  if (myScore == null) return 'ELIM'

  const myIdx = sorted.findIndex(([id]) => id === auth.user!.id)
  if (myIdx === -1) return '--'

  // Count ties
  const myVal = sorted[myIdx][1]
  const rank = sorted.filter(([, score]) => score! < myVal!).length + 1
  const totalPlayers = playerScores.size

  const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'
  return `${rank}${suffix} of ${totalPlayers}`
})

async function fetchData() {
  loading.value = true

  const { data: t } = await supabase
    .from('tournaments')
    .select('*')
    .eq('year', 2026)
    .single()

  tournament.value = t
  if (!t || !auth.user) {
    loading.value = false
    return
  }

  const [picksRes, allPicksRes, profilesRes] = await Promise.all([
    supabase.from('draft_picks').select('*').eq('tournament_id', t.id).eq('user_id', auth.user.id),
    supabase.from('draft_picks').select('*').eq('tournament_id', t.id),
    supabase.from('profiles').select('*'),
  ])

  draftPicks.value = picksRes.data ?? []
  allDraftPicks.value = allPicksRes.data ?? []
  profiles.value = profilesRes.data ?? []

  const golferIds = draftPicks.value.map(p => p.golfer_id)
  const allGolferIds = [...new Set(allDraftPicks.value.map(p => p.golfer_id))]

  if (golferIds.length > 0) {
    const [golfersRes, scoresRes] = await Promise.all([
      supabase.from('golfers').select('*').in('id', golferIds),
      supabase.from('golfer_scores').select('*').eq('tournament_id', t.id).in('golfer_id', allGolferIds),
    ])
    golfers.value = golfersRes.data ?? []
    golferScores.value = scoresRes.data ?? []
  }

  loading.value = false
}

function setupRealtimeSubscription() {
  if (!tournament.value) return

  channel = supabase
    .channel('my-team-scores')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'golfer_scores', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        const allGolferIds = [...new Set(allDraftPicks.value.map(p => p.golfer_id))]
        if (allGolferIds.length > 0) {
          const { data } = await supabase
            .from('golfer_scores')
            .select('*')
            .eq('tournament_id', tournament.value!.id)
            .in('golfer_id', allGolferIds)
          golferScores.value = data ?? []
        }
      }
    )
    .subscribe()
}

onMounted(async () => {
  await fetchData()
  setupRealtimeSubscription()
})

onUnmounted(() => {
  if (channel) supabase.removeChannel(channel)
})
</script>

<template>
  <div class="p-4 max-w-lg mx-auto space-y-4 pb-20">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="text-center pt-2">
        <h1 class="text-2xl font-bold text-dark">My Team</h1>

        <!-- Combined Score -->
        <div v-if="tournamentStarted && combinedScore !== null" class="mt-3">
          <p
            class="text-4xl font-bold font-score"
            :class="combinedScore < 0 ? 'text-red-600' : combinedScore > 0 ? 'text-dark' : 'text-dark'"
          >
            Combined: {{ formatToPar(combinedScore) }}
          </p>
          <p class="text-dark/50 text-sm mt-1 font-medium">
            Best 2 of 4 golfers
          </p>
        </div>

        <!-- Rank -->
        <div v-if="tournamentStarted && currentRank !== '--'" class="mt-2">
          <span
            class="inline-block px-4 py-1.5 rounded-full text-sm font-bold"
            :class="currentRank === 'ELIM' ? 'bg-red-100 text-red-700' : 'bg-augusta/10 text-augusta'"
          >
            {{ currentRank === 'ELIM' ? 'ELIMINATED' : currentRank }}
          </span>
        </div>

        <!-- Pre-tournament message -->
        <div v-if="!tournamentStarted && draftPicks.length > 0" class="mt-3">
          <p class="text-dark/50 text-sm">Tournament hasn't started yet</p>
        </div>
      </div>

      <!-- Eliminated Banner -->
      <div
        v-if="tournamentStarted && isEliminated"
        class="bg-red-600 text-white rounded-2xl p-5 text-center shadow-lg"
      >
        <p class="text-2xl font-bold tracking-wide">ELIMINATED</p>
        <p class="text-white/80 text-sm mt-1">
          Fewer than 2 golfers made the cut
        </p>
      </div>

      <!-- No picks -->
      <div v-if="draftPicks.length === 0" class="bg-white rounded-2xl shadow-md p-8 text-center">
        <p class="text-dark/50 text-lg">No golfers drafted yet</p>
        <router-link to="/draft" class="text-augusta font-semibold text-sm mt-3 inline-block hover:underline">
          Go to Draft &rarr;
        </router-link>
      </div>

      <!-- Golfer Cards -->
      <div
        v-for="tg in teamGolfers"
        :key="tg.pick.id"
        class="bg-white rounded-2xl shadow-md overflow-hidden transition-all"
        :class="{
          'border-2 border-gold shadow-gold/20': tournamentStarted && tg.counting,
          'border-2 border-red-400': tournamentStarted && !isActive(tg.score),
          'opacity-50': tournamentStarted && !tg.counting && isActive(tg.score),
        }"
      >
        <!-- Counting / Not Counting Badge -->
        <div
          v-if="tournamentStarted && tg.counting"
          class="bg-gold/15 text-gold px-4 py-1 text-xs font-bold uppercase tracking-wider text-center"
        >
          COUNTING
        </div>
        <div
          v-else-if="tournamentStarted && isActive(tg.score) && !tg.counting"
          class="bg-dark/5 text-dark/40 px-4 py-1 text-xs font-bold uppercase tracking-wider text-center"
        >
          NOT COUNTING
        </div>

        <div class="p-4">
          <!-- Top row: name + status -->
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-bold text-dark truncate">{{ tg.golfer.name }}</h3>
              <div class="flex items-center gap-2 mt-1">
                <!-- Position -->
                <span
                  v-if="tournamentStarted && tg.score"
                  class="text-sm font-semibold font-score"
                  :class="{
                    'text-red-600': isCut(tg.score) || isDQ(tg.score),
                    'text-orange-600': isWithdrawn(tg.score),
                    'text-dark/70': isActive(tg.score),
                  }"
                >
                  {{ tg.score.position ?? '--' }}
                </span>
                <!-- Pre-tournament info -->
                <span v-if="!tournamentStarted" class="text-sm text-dark/50">
                  #{{ tg.golfer.world_ranking }} &middot; {{ tg.golfer.odds ?? '--' }}
                </span>
              </div>
            </div>

            <!-- To Par (large) -->
            <div v-if="tournamentStarted" class="text-right shrink-0">
              <p
                class="text-2xl font-bold font-score"
                :class="(tg.score?.to_par ?? 0) < 0 ? 'text-red-600' : (tg.score?.to_par ?? 0) > 0 ? 'text-dark' : 'text-dark'"
              >
                {{ formatToPar(tg.score?.to_par ?? null) }}
              </p>
            </div>
          </div>

          <!-- Today + Thru -->
          <div v-if="tournamentStarted && tg.score && isActive(tg.score)" class="mt-2">
            <p class="text-sm text-dark/50">
              Today: <span class="font-score font-semibold text-dark/70">{{ formatToday(tg.score.today, tg.score.thru) }}</span>
            </p>
          </div>

          <!-- Status Badge -->
          <div class="flex items-center gap-2 mt-3">
            <span
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold text-white"
              :class="statusColor(tg.score)"
            >
              {{ statusLabel(tg.score) }}
            </span>
          </div>

          <!-- Round Scores -->
          <div v-if="tournamentStarted && tg.score" class="grid grid-cols-4 gap-2 mt-3 pt-3 border-t border-dark/8">
            <div v-for="round in [1, 2, 3, 4]" :key="round" class="text-center">
              <span class="text-[10px] text-dark/40 uppercase">R{{ round }}</span>
              <p class="font-score font-semibold text-sm text-dark">
                {{ (tg.score as any)[`r${round}`] ?? '--' }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
