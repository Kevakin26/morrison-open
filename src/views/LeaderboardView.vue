<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/lib/supabase'

import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Tournament = Database['public']['Tables']['tournaments']['Row']
type DraftPick = Database['public']['Tables']['draft_picks']['Row']
type Golfer = Database['public']['Tables']['golfers']['Row']
type GolferScore = Database['public']['Tables']['golfer_scores']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']

interface PlayerStanding {
  userId: string
  name: string
  combinedScore: number | null
  golfers: PlayerGolfer[]
  winningOdds: number | null
}

interface PlayerGolfer {
  golfer: Golfer
  score: GolferScore | null
  counting: boolean
}

interface MastersEntry {
  golfer: Golfer
  score: GolferScore | null
  draftedBy: string | null
}

const activeTab = ref<'morrison' | 'masters'>('morrison')
const tournament = ref<Tournament | null>(null)
const profiles = ref<Profile[]>([])
const draftPicks = ref<DraftPick[]>([])
const golferScores = ref<GolferScore[]>([])
const golfers = ref<Golfer[]>([])
const loading = ref(true)
const expandedPlayer = ref<string | null>(null)

let channel: RealtimeChannel | null = null

function formatToPar(n: number | null): string {
  if (n == null) return '--'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : `${n}`
}

function isGolferActive(score: GolferScore | null): boolean {
  if (!score) return true
  return score.status?.toLowerCase() === 'active'
}

function parseOddsToProb(odds: string | null): number {
  if (!odds) return 0
  const n = parseInt(odds.replace('+', ''), 10)
  if (isNaN(n) || n <= 0) return 0
  return 100 / (n + 100) // American odds to implied probability
}

// Morrison Open standings
const playerStandings = computed<PlayerStanding[]>(() => {
  // Group picks by user
  const picksByUser = new Map<string, DraftPick[]>()
  for (const pick of draftPicks.value) {
    if (!picksByUser.has(pick.user_id)) picksByUser.set(pick.user_id, [])
    picksByUser.get(pick.user_id)!.push(pick)
  }

  const standings: PlayerStanding[] = []

  for (const profile of profiles.value) {
    const picks = picksByUser.get(profile.id) ?? []
    const playerGolfers: PlayerGolfer[] = picks.map(p => {
      const golfer = golfers.value.find(g => g.id === p.golfer_id)
      const score = golferScores.value.find(gs => gs.golfer_id === p.golfer_id) ?? null
      return { golfer: golfer!, score, counting: false }
    }).filter(pg => pg.golfer)

    // Separate active vs inactive
    const active = playerGolfers.filter(pg => isGolferActive(pg.score))
    const inactive = playerGolfers.filter(pg => !isGolferActive(pg.score))

    // Sort active by to_par ascending
    active.sort((a, b) => (a.score?.to_par ?? 999) - (b.score?.to_par ?? 999))

    // Mark best 2 as counting
    active.forEach((pg, idx) => {
      pg.counting = idx < 2
    })

    let combinedScore: number | null = null

    const counting = active.filter(pg => pg.counting)
    const withScores = counting.filter(pg => pg.score?.to_par != null)
    if (withScores.length > 0) {
      combinedScore = withScores.reduce((sum, pg) => sum + (pg.score?.to_par ?? 0), 0)
    }

    // Winning odds: implied probability of best 2 golfers
    let winningOdds: number | null = null
    if (active.length >= 2) {
      const best2 = active.slice(0, 2)
      const prob = best2.reduce((sum, pg) => sum + parseOddsToProb(pg.golfer.odds), 0)
      winningOdds = prob
    }

    standings.push({
      userId: profile.id,
      name: profile.display_name,
      combinedScore,
      golfers: [...active, ...inactive],
      winningOdds,
    })
  }

  // Normalize winning odds
  const totalProb = standings.reduce((sum, s) => sum + (s.winningOdds ?? 0), 0)
  if (totalProb > 0) {
    for (const s of standings) {
      if (s.winningOdds != null) {
        s.winningOdds = (s.winningOdds / totalProb) * 100
      }
    }
  }

  // Sort by combinedScore; null scores go to bottom
  standings.sort((a, b) => (a.combinedScore ?? 999) - (b.combinedScore ?? 999))

  return standings
})

// Compute ranks with ties
const rankedStandings = computed(() => {
  const result: { standing: PlayerStanding; rank: string }[] = []
  const withScore = playerStandings.value.filter(s => s.combinedScore !== null)
  const noScore = playerStandings.value.filter(s => s.combinedScore === null)

  for (let i = 0; i < withScore.length; i++) {
    const s = withScore[i]
    const sameScore = withScore.filter(x => x.combinedScore === s.combinedScore).length
    const rank = withScore.filter(x => (x.combinedScore ?? 999) < (s.combinedScore ?? 999)).length + 1
    const prefix = sameScore > 1 ? 'T' : ''
    result.push({ standing: s, rank: `${prefix}${rank}` })
  }

  for (const s of noScore) {
    result.push({ standing: s, rank: '--' })
  }

  return result
})

// Masters leaderboard
const mastersLeaderboard = computed<MastersEntry[]>(() => {
  // Build draft map: golfer_id -> player name
  const draftMap = new Map<string, string>()
  for (const pick of draftPicks.value) {
    const profile = profiles.value.find(p => p.id === pick.user_id)
    if (profile) draftMap.set(pick.golfer_id, profile.display_name)
  }

  const entries: MastersEntry[] = golfers.value.map(golfer => {
    const score = golferScores.value.find(gs => gs.golfer_id === golfer.id) ?? null
    return {
      golfer,
      score,
      draftedBy: draftMap.get(golfer.id) ?? null,
    }
  })

  // Sort by position / to_par
  entries.sort((a, b) => {
    // Active golfers first, then cut/wd/dq
    const aActive = isGolferActive(a.score)
    const bActive = isGolferActive(b.score)
    if (aActive && !bActive) return -1
    if (!aActive && bActive) return 1

    // Then by to_par
    const aScore = a.score?.to_par ?? 999
    const bScore = b.score?.to_par ?? 999
    return aScore - bScore
  })

  return entries
})

// Find cut line index (last active golfer after R2)
const cutLineIndex = computed(() => {
  const round = tournament.value?.current_round ?? 0
  if (round < 2) return -1

  let lastActive = -1
  for (let i = 0; i < mastersLeaderboard.value.length; i++) {
    if (isGolferActive(mastersLeaderboard.value[i].score)) {
      lastActive = i
    }
  }
  return lastActive
})

function toggleExpand(userId: string) {
  expandedPlayer.value = expandedPlayer.value === userId ? null : userId
}

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

  const [profilesRes, picksRes, scoresRes, golfersRes] = await Promise.all([
    supabase.from('profiles').select('*'),
    supabase.from('draft_picks').select('*').eq('tournament_id', t.id),
    supabase.from('golfer_scores').select('*').eq('tournament_id', t.id),
    supabase.from('golfers').select('*').eq('is_active', true),
  ])

  profiles.value = profilesRes.data ?? []
  draftPicks.value = picksRes.data ?? []
  golferScores.value = scoresRes.data ?? []
  golfers.value = golfersRes.data ?? []

  loading.value = false
}

function setupRealtimeSubscription() {
  if (!tournament.value) return

  channel = supabase
    .channel('leaderboard-scores')
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
  <div class="p-4 sm:p-6 lg:p-8 max-w-2xl lg:max-w-4xl mx-auto pb-24">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="flex items-center justify-between pt-2 mb-4">
        <h1 class="text-2xl font-bold text-dark">Leaderboard</h1>
        <router-link
          to="/matchup"
          class="text-sm font-semibold text-augusta hover:text-augusta-dark transition-colors min-h-[44px] flex items-center"
        >
          Head to Head &rarr;
        </router-link>
      </div>

      <!-- Tabs -->
      <div class="flex bg-white rounded-xl shadow-sm border border-dark/8 p-1 mb-5">
        <button
          @click="activeTab = 'morrison'"
          class="flex-1 py-2.5 min-h-[44px] rounded-lg text-sm font-semibold transition-colors cursor-pointer"
          :class="activeTab === 'morrison' ? 'bg-augusta text-white' : 'text-dark/60 hover:text-dark'"
        >
          Morrison Open
        </button>
        <button
          @click="activeTab = 'masters'"
          class="flex-1 py-2.5 min-h-[44px] rounded-lg text-sm font-semibold transition-colors cursor-pointer"
          :class="activeTab === 'masters' ? 'bg-augusta text-white' : 'text-dark/60 hover:text-dark'"
        >
          Masters Leaderboard
        </button>
      </div>

      <!-- ==================== MORRISON OPEN TAB ==================== -->
      <div v-if="activeTab === 'morrison'" class="space-y-2">
        <div
          v-for="({ standing, rank }, idx) in rankedStandings"
          :key="standing.userId"
        >
          <!-- Player Row -->
          <button
            @click="toggleExpand(standing.userId)"
            class="w-full bg-white rounded-xl shadow-sm border transition-all cursor-pointer min-h-[48px]"
            :class="{
              'border-gold/50 bg-gold/5': idx === 0,
              'border-dark/8': idx !== 0,
            }"
          >
            <div class="flex items-center gap-3 p-4">
              <!-- Rank -->
              <div class="w-10 shrink-0 text-center">
                <span
                  class="text-lg font-bold font-score"
                  :class="idx === 0 ? 'text-gold' : 'text-dark/40'"
                >
                  {{ rank }}
                </span>
              </div>

              <!-- Name -->
              <div class="flex-1 text-left min-w-0">
                <p class="font-semibold text-dark truncate">{{ standing.name }}</p>
                <p v-if="standing.winningOdds != null" class="text-[11px] text-dark/40 mt-0.5">
                  Winning Odds: {{ standing.winningOdds.toFixed(1) }}%
                </p>
              </div>

              <!-- Mini golfer indicators -->
              <div class="flex gap-1 shrink-0">
                <div
                  v-for="(pg, gIdx) in standing.golfers"
                  :key="gIdx"
                  class="w-3 h-3 rounded-full"
                  :class="{
                    'bg-gold': pg.counting,
                    'bg-dark/20': !pg.counting && isGolferActive(pg.score),
                    'bg-red-400': !isGolferActive(pg.score),
                  }"
                  :title="pg.golfer.name"
                ></div>
              </div>

              <!-- Combined Score -->
              <div class="w-14 text-right shrink-0">
                <span
                  class="text-lg font-bold font-score"
                  :class="{
                    'text-red-600': (standing.combinedScore ?? 0) < 0,
                    'text-dark': (standing.combinedScore ?? 0) >= 0,
                    'text-dark/30': standing.combinedScore === null,
                  }"
                >
                  {{ formatToPar(standing.combinedScore) }}
                </span>
              </div>

              <!-- Expand indicator -->
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-4 w-4 text-dark/30 transition-transform shrink-0"
                :class="{ 'rotate-180': expandedPlayer === standing.userId }"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
            </div>
          </button>

          <!-- Expanded Detail -->
          <div
            v-if="expandedPlayer === standing.userId"
            class="bg-white rounded-xl shadow-sm border border-dark/8 mt-1 overflow-hidden"
          >
            <div
              v-for="pg in standing.golfers"
              :key="pg.golfer.id"
              class="flex items-center gap-3 px-4 py-3 border-b border-dark/5 last:border-b-0"
              :class="{ 'bg-gold/5': pg.counting }"
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <p class="font-medium text-dark text-sm truncate">{{ pg.golfer.name }}</p>
                  <span
                    v-if="pg.counting"
                    class="text-[9px] font-bold text-gold bg-gold/15 px-1.5 py-0.5 rounded uppercase"
                  >
                    Counting
                  </span>
                  <span
                    v-if="!isGolferActive(pg.score)"
                    class="text-[9px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded uppercase"
                  >
                    {{ pg.score?.status?.toUpperCase() }}
                  </span>
                </div>
                <p class="text-[11px] text-dark/40 mt-0.5">
                  <span v-if="pg.score?.position">{{ pg.score.position }} &middot; </span>
                  <span v-if="pg.score?.today != null">Today: {{ formatToPar(pg.score.today) }}</span>
                  <span v-if="pg.score?.thru"> thru {{ pg.score.thru }}</span>
                </p>
              </div>

              <!-- Round scores -->
              <div class="flex gap-2 shrink-0">
                <div v-for="round in [1, 2, 3, 4]" :key="round" class="text-center">
                  <span class="text-[9px] text-dark/30 block">R{{ round }}</span>
                  <span class="font-score text-xs font-semibold text-dark">
                    {{ (pg.score as any)?.[`r${round}`] ?? '--' }}
                  </span>
                </div>
              </div>

              <!-- To Par -->
              <div class="w-10 text-right shrink-0">
                <span
                  class="font-bold font-score text-sm"
                  :class="(pg.score?.to_par ?? 0) < 0 ? 'text-red-600' : 'text-dark'"
                >
                  {{ formatToPar(pg.score?.to_par ?? null) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== MASTERS LEADERBOARD TAB ==================== -->
      <div v-if="activeTab === 'masters'" class="overflow-x-auto overscroll-contain -mx-4 sm:mx-0">
        <!-- Table Header -->
        <div class="flex items-center gap-2 px-4 py-2 text-[10px] text-dark/40 uppercase tracking-wider font-semibold border-b border-dark/10 min-w-[540px]">
          <div class="w-10 text-center">Pos</div>
          <div class="flex-1">Player</div>
          <div class="w-12 text-center">To Par</div>
          <div class="w-14 text-center">Today</div>
          <div class="w-10 text-center">Thru</div>
          <div class="w-8 text-center">R1</div>
          <div class="w-8 text-center">R2</div>
          <div class="w-8 text-center">R3</div>
          <div class="w-8 text-center">R4</div>
        </div>

        <!-- Golfer Rows -->
        <div
          v-for="(entry, idx) in mastersLeaderboard"
          :key="entry.golfer.id"
        >
          <!-- Cut line -->
          <div
            v-if="cutLineIndex >= 0 && idx === cutLineIndex + 1"
            class="flex items-center gap-2 px-4 py-1 min-w-[540px]"
          >
            <div class="flex-1 border-t-2 border-dashed border-red-400"></div>
            <span class="text-[10px] text-red-500 font-bold uppercase shrink-0">Projected Cut</span>
            <div class="flex-1 border-t-2 border-dashed border-red-400"></div>
          </div>

          <div
            class="flex items-center gap-2 px-4 py-2.5 border-b border-dark/5 min-w-[540px]"
            :class="{
              'bg-red-50/50': !isGolferActive(entry.score),
            }"
          >
            <!-- Position -->
            <div class="w-10 text-center">
              <span
                class="font-score text-sm font-semibold"
                :class="!isGolferActive(entry.score) ? 'text-red-500' : 'text-dark'"
              >
                {{ entry.score?.position ?? '--' }}
              </span>
            </div>

            <!-- Name + drafted by -->
            <div class="flex-1 min-w-0">
              <p class="font-medium text-dark text-sm truncate">{{ entry.golfer.name }}</p>
              <p v-if="entry.draftedBy" class="text-[10px] text-augusta font-semibold mt-0.5">
                Drafted by: {{ entry.draftedBy }}
              </p>
            </div>

            <!-- To Par -->
            <div class="w-12 text-center">
              <span
                class="font-score text-sm font-bold"
                :class="(entry.score?.to_par ?? 0) < 0 ? 'text-red-600' : 'text-dark'"
              >
                {{ formatToPar(entry.score?.to_par ?? null) }}
              </span>
            </div>

            <!-- Today -->
            <div class="w-14 text-center">
              <span class="font-score text-xs text-dark/70">
                {{ formatToPar(entry.score?.today ?? null) }}
              </span>
            </div>

            <!-- Thru -->
            <div class="w-10 text-center">
              <span class="font-score text-xs text-dark/50">
                {{ entry.score?.thru ?? '--' }}
              </span>
            </div>

            <!-- Round scores -->
            <div class="w-8 text-center">
              <span class="font-score text-xs text-dark/70">{{ entry.score?.r1 ?? '--' }}</span>
            </div>
            <div class="w-8 text-center">
              <span class="font-score text-xs text-dark/70">{{ entry.score?.r2 ?? '--' }}</span>
            </div>
            <div class="w-8 text-center">
              <span class="font-score text-xs text-dark/70">{{ entry.score?.r3 ?? '--' }}</span>
            </div>
            <div class="w-8 text-center">
              <span class="font-score text-xs text-dark/70">{{ entry.score?.r4 ?? '--' }}</span>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div v-if="mastersLeaderboard.length === 0" class="text-center py-12 text-dark/50">
          <p>No scores available yet</p>
        </div>
      </div>

      <!-- Morrison Open tab: matchup link -->
      <div v-if="activeTab === 'morrison'" class="mt-4 text-center">
        <router-link
          to="/matchup"
          class="inline-flex items-center gap-1 text-sm font-semibold text-augusta hover:underline min-h-[44px]"
        >
          Compare Head to Head &rarr;
        </router-link>
      </div>
    </template>
  </div>
</template>
