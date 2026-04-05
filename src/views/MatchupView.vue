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

interface MatchupGolfer {
  golfer: Golfer
  score: GolferScore | null
  counting: boolean
}

interface PlayerSide {
  profile: Profile
  golfers: MatchupGolfer[]
  combinedScore: number | null
  eliminated: boolean
}

const auth = useAuthStore()

const tournament = ref<Tournament | null>(null)
const profiles = ref<Profile[]>([])
const draftPicks = ref<DraftPick[]>([])
const golfers = ref<Golfer[]>([])
const golferScores = ref<GolferScore[]>([])
const loading = ref(true)

const player1Id = ref<string | null>(null)
const player2Id = ref<string | null>(null)

let channel: RealtimeChannel | null = null

function formatToPar(n: number | null): string {
  if (n == null) return '--'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : `${n}`
}

function isGolferActive(score: GolferScore | null): boolean {
  if (!score) return true
  return score.status === 'active'
}

function statusLabel(score: GolferScore | null): string | null {
  if (!score) return null
  const s = score.status.toLowerCase()
  if (s === 'active') return null
  if (s === 'cut') return 'CUT'
  if (s === 'withdrawn' || s === 'wd') return 'WD'
  if (s === 'dq' || s === 'disqualified') return 'DQ'
  return score.status.toUpperCase()
}

function buildPlayerSide(userId: string): PlayerSide | null {
  const profile = profiles.value.find(p => p.id === userId) ?? null
  if (!profile) return null

  const picks = draftPicks.value.filter(p => p.user_id === userId)
  const playerGolfers: MatchupGolfer[] = picks.map(pick => {
    const golfer = golfers.value.find(g => g.id === pick.golfer_id)
    const score = golferScores.value.find(gs => gs.golfer_id === pick.golfer_id) ?? null
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

  const eliminated = active.length < 2
  let combinedScore: number | null = null

  if (!eliminated) {
    const counting = active.filter(pg => pg.counting)
    combinedScore = counting.reduce((sum, pg) => sum + (pg.score?.to_par ?? 0), 0)
  }

  return {
    profile,
    golfers: [...active, ...inactive],
    combinedScore,
    eliminated,
  }
}

const player1Side = computed<PlayerSide | null>(() => {
  if (!player1Id.value) return null
  return buildPlayerSide(player1Id.value)
})

const player2Side = computed<PlayerSide | null>(() => {
  if (!player2Id.value) return null
  return buildPlayerSide(player2Id.value)
})

const leader = computed<'player1' | 'player2' | 'tied' | null>(() => {
  if (!player1Side.value || !player2Side.value) return null
  if (player1Side.value.eliminated && player2Side.value.eliminated) return null
  if (player1Side.value.eliminated) return 'player2'
  if (player2Side.value.eliminated) return 'player1'
  if (player1Side.value.combinedScore == null || player2Side.value.combinedScore == null) return null
  if (player1Side.value.combinedScore < player2Side.value.combinedScore) return 'player1'
  if (player2Side.value.combinedScore < player1Side.value.combinedScore) return 'player2'
  return 'tied'
})

const strokeDifference = computed<number>(() => {
  if (!player1Side.value || !player2Side.value) return 0
  if (player1Side.value.combinedScore == null || player2Side.value.combinedScore == null) return 0
  return Math.abs(player1Side.value.combinedScore - player2Side.value.combinedScore)
})

function swapPlayers() {
  const temp = player1Id.value
  player1Id.value = player2Id.value
  player2Id.value = temp
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

  // Default player 1 to current user
  if (auth.user && profiles.value.some(p => p.id === auth.user!.id)) {
    player1Id.value = auth.user.id
  } else if (profiles.value.length > 0) {
    player1Id.value = profiles.value[0].id
  }

  // Default player 2 to the first other player
  const otherProfiles = profiles.value.filter(p => p.id !== player1Id.value)
  if (otherProfiles.length > 0) {
    player2Id.value = otherProfiles[0].id
  }

  loading.value = false
}

function setupRealtimeSubscription() {
  if (!tournament.value) return

  channel = supabase
    .channel('matchup-scores')
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
  <div class="p-4 max-w-2xl mx-auto pb-20">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- Header -->
      <h1 class="text-2xl font-bold text-dark text-center pt-2 mb-5">Head to Head</h1>

      <!-- Player Selectors -->
      <div class="flex items-center gap-2 mb-5">
        <!-- Player 1 Selector -->
        <div class="flex-1">
          <select
            v-model="player1Id"
            class="w-full bg-white border border-dark/15 rounded-xl px-3 py-2.5 text-sm font-semibold text-dark focus:outline-none focus:ring-2 focus:ring-augusta/30 focus:border-augusta appearance-none cursor-pointer"
          >
            <option v-for="p in profiles" :key="p.id" :value="p.id">
              {{ p.display_name }}
            </option>
          </select>
        </div>

        <!-- VS + Swap Button -->
        <div class="flex flex-col items-center shrink-0">
          <span class="text-xs font-bold text-dark/40 uppercase">vs</span>
          <button
            @click="swapPlayers"
            class="mt-1 w-8 h-8 flex items-center justify-center rounded-full bg-dark/5 hover:bg-dark/10 transition-colors cursor-pointer"
            title="Swap players"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-dark/50" viewBox="0 0 20 20" fill="currentColor">
              <path d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
            </svg>
          </button>
        </div>

        <!-- Player 2 Selector -->
        <div class="flex-1">
          <select
            v-model="player2Id"
            class="w-full bg-white border border-dark/15 rounded-xl px-3 py-2.5 text-sm font-semibold text-dark focus:outline-none focus:ring-2 focus:ring-augusta/30 focus:border-augusta appearance-none cursor-pointer"
          >
            <option v-for="p in profiles" :key="p.id" :value="p.id">
              {{ p.display_name }}
            </option>
          </select>
        </div>
      </div>

      <!-- Score Comparison Bar -->
      <div
        v-if="player1Side && player2Side"
        class="bg-white rounded-2xl shadow-md border border-dark/8 p-4 mb-5"
      >
        <div class="flex items-center justify-between">
          <!-- Player 1 Score -->
          <div class="text-center flex-1">
            <p class="text-sm font-semibold text-dark/60 mb-1 truncate">{{ player1Side.profile.display_name }}</p>
            <p
              class="text-3xl font-bold font-score"
              :class="{
                'text-red-600': (player1Side.combinedScore ?? 0) < 0,
                'text-dark': (player1Side.combinedScore ?? 0) >= 0,
                'text-dark/30': player1Side.eliminated,
              }"
            >
              {{ player1Side.eliminated ? '--' : formatToPar(player1Side.combinedScore) }}
            </p>
            <p v-if="player1Side.eliminated" class="text-xs font-bold text-red-600 mt-1">ELIMINATED</p>
          </div>

          <!-- Leader Indicator -->
          <div class="flex flex-col items-center px-4 shrink-0">
            <!-- Arrow or check pointing to the leader -->
            <div v-if="leader === 'player1'" class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd" />
              </svg>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
              </svg>
            </div>
            <div v-else-if="leader === 'player2'" class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
              </svg>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
              </svg>
            </div>
            <div v-else-if="leader === 'tied'" class="text-sm font-bold text-dark/40">
              TIED
            </div>
            <div v-else class="text-sm font-bold text-dark/20">
              --
            </div>

            <!-- Stroke difference -->
            <p
              v-if="leader === 'player1' || leader === 'player2'"
              class="text-[11px] text-green-600 font-semibold mt-1 text-center whitespace-nowrap"
            >
              Leading by {{ strokeDifference }} stroke{{ strokeDifference !== 1 ? 's' : '' }}
            </p>
          </div>

          <!-- Player 2 Score -->
          <div class="text-center flex-1">
            <p class="text-sm font-semibold text-dark/60 mb-1 truncate">{{ player2Side.profile.display_name }}</p>
            <p
              class="text-3xl font-bold font-score"
              :class="{
                'text-red-600': (player2Side.combinedScore ?? 0) < 0,
                'text-dark': (player2Side.combinedScore ?? 0) >= 0,
                'text-dark/30': player2Side.eliminated,
              }"
            >
              {{ player2Side.eliminated ? '--' : formatToPar(player2Side.combinedScore) }}
            </p>
            <p v-if="player2Side.eliminated" class="text-xs font-bold text-red-600 mt-1">ELIMINATED</p>
          </div>
        </div>
      </div>

      <!-- Side-by-Side Golfer Comparison -->
      <div v-if="player1Side && player2Side" class="grid grid-cols-2 gap-3">
        <!-- Player 1 Column -->
        <div class="space-y-2">
          <p class="text-xs font-bold text-dark/40 uppercase tracking-wider text-center mb-2">
            {{ player1Side.profile.display_name }}
          </p>

          <div
            v-for="pg in player1Side.golfers"
            :key="pg.golfer.id"
            class="bg-white rounded-xl shadow-sm border overflow-hidden transition-all"
            :class="{
              'border-gold/50 bg-gold/5': pg.counting,
              'border-dark/8': !pg.counting && isGolferActive(pg.score),
              'border-red-300 bg-red-50/50 opacity-60': !isGolferActive(pg.score),
              'opacity-50': !pg.counting && isGolferActive(pg.score),
            }"
          >
            <!-- Counting Badge -->
            <div
              v-if="pg.counting"
              class="bg-gold/15 text-gold px-3 py-0.5 text-[9px] font-bold uppercase tracking-wider text-center"
            >
              COUNTING
            </div>

            <div class="p-3">
              <!-- Name -->
              <p class="font-semibold text-dark text-sm truncate">{{ pg.golfer.name }}</p>

              <!-- Position + To Par -->
              <div class="flex items-center justify-between mt-1.5">
                <span class="text-xs text-dark/50">
                  {{ pg.score?.position ?? '--' }}
                </span>
                <span
                  class="font-bold font-score text-sm"
                  :class="(pg.score?.to_par ?? 0) < 0 ? 'text-red-600' : 'text-dark'"
                >
                  {{ formatToPar(pg.score?.to_par ?? null) }}
                </span>
              </div>

              <!-- Status Badge (CUT, WD, DQ) -->
              <div v-if="statusLabel(pg.score)" class="mt-1.5">
                <span class="text-[9px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded uppercase">
                  {{ statusLabel(pg.score) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="player1Side.golfers.length === 0" class="bg-white rounded-xl border border-dark/8 p-4 text-center">
            <p class="text-dark/40 text-xs">No golfers drafted</p>
          </div>
        </div>

        <!-- Player 2 Column -->
        <div class="space-y-2">
          <p class="text-xs font-bold text-dark/40 uppercase tracking-wider text-center mb-2">
            {{ player2Side.profile.display_name }}
          </p>

          <div
            v-for="pg in player2Side.golfers"
            :key="pg.golfer.id"
            class="bg-white rounded-xl shadow-sm border overflow-hidden transition-all"
            :class="{
              'border-gold/50 bg-gold/5': pg.counting,
              'border-dark/8': !pg.counting && isGolferActive(pg.score),
              'border-red-300 bg-red-50/50 opacity-60': !isGolferActive(pg.score),
              'opacity-50': !pg.counting && isGolferActive(pg.score),
            }"
          >
            <!-- Counting Badge -->
            <div
              v-if="pg.counting"
              class="bg-gold/15 text-gold px-3 py-0.5 text-[9px] font-bold uppercase tracking-wider text-center"
            >
              COUNTING
            </div>

            <div class="p-3">
              <!-- Name -->
              <p class="font-semibold text-dark text-sm truncate">{{ pg.golfer.name }}</p>

              <!-- Position + To Par -->
              <div class="flex items-center justify-between mt-1.5">
                <span class="text-xs text-dark/50">
                  {{ pg.score?.position ?? '--' }}
                </span>
                <span
                  class="font-bold font-score text-sm"
                  :class="(pg.score?.to_par ?? 0) < 0 ? 'text-red-600' : 'text-dark'"
                >
                  {{ formatToPar(pg.score?.to_par ?? null) }}
                </span>
              </div>

              <!-- Status Badge (CUT, WD, DQ) -->
              <div v-if="statusLabel(pg.score)" class="mt-1.5">
                <span class="text-[9px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded uppercase">
                  {{ statusLabel(pg.score) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Empty state -->
          <div v-if="player2Side.golfers.length === 0" class="bg-white rounded-xl border border-dark/8 p-4 text-center">
            <p class="text-dark/40 text-xs">No golfers drafted</p>
          </div>
        </div>
      </div>

      <!-- No players selected state -->
      <div v-if="profiles.length < 2" class="bg-white rounded-2xl shadow-md p-8 text-center">
        <p class="text-dark/50">Need at least 2 players to compare</p>
      </div>
    </template>
  </div>
</template>
