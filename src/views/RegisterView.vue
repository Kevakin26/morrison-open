<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const displayName = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)
const submitted = ref(false)


const nameError = computed(() => {
  if (!submitted.value && !displayName.value) return ''
  if (displayName.value.length === 0) return 'Display name is required.'
  if (displayName.value.length < 2) return 'Must be at least 2 characters.'
  if (displayName.value.length > 20) return 'Must be 20 characters or fewer.'
  return ''
})

const passwordError = computed(() => {
  if (!submitted.value && !password.value) return ''
  if (password.value.length === 0) return 'Password is required.'
  if (password.value.length < 6) return 'Must be at least 6 characters.'
  return ''
})

const confirmError = computed(() => {
  if (!submitted.value && !confirmPassword.value) return ''
  if (confirmPassword.value.length === 0) return 'Please confirm your password.'
  if (confirmPassword.value !== password.value) return 'Passwords do not match.'
  return ''
})

const isValid = computed(() => {
  return (
    displayName.value.length >= 2 &&
    displayName.value.length <= 20 &&
    password.value.length >= 6 &&
    confirmPassword.value === password.value &&
    email.value.length > 0
  )
})

async function handleRegister() {
  submitted.value = true
  error.value = ''

  if (!isValid.value) return

  loading.value = true
  try {
    await auth.register(email.value, password.value, displayName.value)
    router.push('/home')
  } catch (e: any) {
    error.value = e.message || 'Registration failed. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-golf-login flex items-center justify-center px-4 sm:px-6 py-8 sm:py-12">
    <div class="w-full max-w-md sm:max-w-lg">
      <!-- Header -->
      <div class="text-center mb-8">
        <div class="text-6xl mb-3">⛳</div>
        <h1 class="text-gold-glow text-3xl sm:text-4xl font-bold tracking-wide uppercase">
          Join The Morrison Open
        </h1>
        <p class="text-cream/80 text-sm mt-2 tracking-widest uppercase">
          Weekly PGA Fantasy
        </p>
      </div>

      <!-- Register Card -->
      <div class="bg-white/10 backdrop-blur-md rounded-2xl p-5 sm:p-8 shadow-2xl border border-white/10">
        <h2 class="text-cream text-xl font-semibold text-center mb-6">Create Account</h2>

        <!-- Auth Error -->
        <div v-if="error" class="mb-4 rounded-lg bg-red-500/20 border border-red-400/30 px-4 py-3">
          <p class="text-red-200 text-sm text-center">{{ error }}</p>
        </div>

        <form @submit.prevent="handleRegister" class="space-y-5">
          <!-- Display Name -->
          <div>
            <label class="block text-cream/70 text-sm font-medium mb-1.5">Display Name</label>
            <input
              v-model="displayName"
              type="text"
              required
              autocomplete="name"
              placeholder="Your name (2-20 chars)"
              class="w-full px-4 py-3 rounded-lg bg-white text-dark placeholder-dark/40 border border-white/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition"
            />
            <p v-if="nameError" class="mt-1 text-red-300 text-xs">{{ nameError }}</p>
          </div>

          <!-- Email -->
          <div>
            <label class="block text-cream/70 text-sm font-medium mb-1.5">Email</label>
            <input
              v-model="email"
              type="email"
              required
              autocomplete="email"
              placeholder="your@email.com"
              class="w-full px-4 py-3 rounded-lg bg-white text-dark placeholder-dark/40 border border-white/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition"
            />
          </div>

          <!-- Password -->
          <div>
            <label class="block text-cream/70 text-sm font-medium mb-1.5">Password</label>
            <input
              v-model="password"
              type="password"
              required
              autocomplete="new-password"
              placeholder="6+ characters"
              class="w-full px-4 py-3 rounded-lg bg-white text-dark placeholder-dark/40 border border-white/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition"
            />
            <p v-if="passwordError" class="mt-1 text-red-300 text-xs">{{ passwordError }}</p>
          </div>

          <!-- Confirm Password -->
          <div>
            <label class="block text-cream/70 text-sm font-medium mb-1.5">Confirm Password</label>
            <input
              v-model="confirmPassword"
              type="password"
              required
              autocomplete="new-password"
              placeholder="Re-enter password"
              class="w-full px-4 py-3 rounded-lg bg-white text-dark placeholder-dark/40 border border-white/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition"
            />
            <p v-if="confirmError" class="mt-1 text-red-300 text-xs">{{ confirmError }}</p>
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full py-3 min-h-[48px] rounded-lg bg-gold text-dark font-bold text-lg uppercase tracking-wider hover:bg-gold/90 hover:shadow-lg hover:shadow-gold/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <span v-if="loading" class="flex items-center justify-center gap-2">
              <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Creating Account...
            </span>
            <span v-else>Create Account</span>
          </button>
        </form>

        <!-- Link -->
        <p class="mt-6 text-center text-cream/60 text-sm">
          Already have an account?
          <router-link to="/login" class="text-gold hover:text-gold/80 font-semibold transition">
            Sign In
          </router-link>
        </p>
      </div>

      <!-- Footer decoration -->
      <p class="text-center text-cream/30 text-xs mt-8 tracking-widest uppercase">
        Every Sunday. One Winner.
      </p>
    </div>
  </div>
</template>
