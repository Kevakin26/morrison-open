<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

const showForgotPassword = ref(false)
const resetEmail = ref('')
const resetLoading = ref(false)
const resetError = ref('')
const resetSuccess = ref(false)

async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await auth.login(email.value, password.value)
    router.push('/dashboard')
  } catch (e: any) {
    error.value = e.message || 'Failed to sign in. Please try again.'
  } finally {
    loading.value = false
  }
}

async function handleResetPassword() {
  resetError.value = ''
  resetSuccess.value = false
  resetLoading.value = true
  try {
    await auth.resetPassword(resetEmail.value)
    resetSuccess.value = true
  } catch (e: any) {
    resetError.value = e.message || 'Failed to send reset link.'
  } finally {
    resetLoading.value = false
  }
}

function openForgotPassword() {
  resetEmail.value = email.value
  resetError.value = ''
  resetSuccess.value = false
  showForgotPassword.value = true
}
</script>

<template>
  <div class="min-h-screen bg-augusta-gradient flex items-center justify-center px-4 py-12">
    <div class="w-full max-w-md">
      <!-- Header -->
      <div class="text-center mb-8">
        <div class="text-4xl mb-3">⛳</div>
        <h1 class="text-gold-glow text-3xl sm:text-4xl font-bold tracking-wide uppercase">
          The Morrison Open
        </h1>
        <p class="text-cream/80 text-sm mt-2 tracking-widest uppercase">
          Masters Fantasy Golf
        </p>
      </div>

      <!-- Login Card -->
      <div class="bg-white/10 backdrop-blur-md rounded-2xl p-8 shadow-2xl border border-white/10">
        <h2 class="text-cream text-xl font-semibold text-center mb-6">Sign In</h2>

        <!-- Error -->
        <div v-if="error" class="mb-4 rounded-lg bg-red-500/20 border border-red-400/30 px-4 py-3">
          <p class="text-red-200 text-sm text-center">{{ error }}</p>
        </div>

        <form @submit.prevent="handleLogin" class="space-y-5">
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

          <div>
            <label class="block text-cream/70 text-sm font-medium mb-1.5">Password</label>
            <input
              v-model="password"
              type="password"
              required
              autocomplete="current-password"
              placeholder="Enter your password"
              class="w-full px-4 py-3 rounded-lg bg-white text-dark placeholder-dark/40 border border-white/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full py-3 rounded-lg bg-gold text-dark font-bold text-lg uppercase tracking-wider hover:bg-gold/90 hover:shadow-lg hover:shadow-gold/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <span v-if="loading" class="flex items-center justify-center gap-2">
              <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Signing in...
            </span>
            <span v-else>Sign In</span>
          </button>
        </form>

        <!-- Links -->
        <div class="mt-6 text-center space-y-3">
          <button
            @click="openForgotPassword"
            class="text-cream/60 text-sm hover:text-gold transition cursor-pointer bg-transparent border-none"
          >
            Forgot password?
          </button>
          <p class="text-cream/60 text-sm">
            Don't have an account?
            <router-link to="/register" class="text-gold hover:text-gold/80 font-semibold transition">
              Register
            </router-link>
          </p>
        </div>
      </div>

      <!-- Forgot Password Inline Form -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-2"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-2"
      >
        <div v-if="showForgotPassword" class="mt-4 bg-white/10 backdrop-blur-md rounded-2xl p-6 shadow-xl border border-white/10">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-cream text-lg font-semibold">Reset Password</h3>
            <button
              @click="showForgotPassword = false"
              class="text-cream/50 hover:text-cream transition bg-transparent border-none text-xl leading-none cursor-pointer"
            >
              &times;
            </button>
          </div>

          <div v-if="resetSuccess" class="rounded-lg bg-green-500/20 border border-green-400/30 px-4 py-3 mb-4">
            <p class="text-green-200 text-sm text-center">Reset link sent! Check your email.</p>
          </div>

          <div v-if="resetError" class="rounded-lg bg-red-500/20 border border-red-400/30 px-4 py-3 mb-4">
            <p class="text-red-200 text-sm text-center">{{ resetError }}</p>
          </div>

          <form v-if="!resetSuccess" @submit.prevent="handleResetPassword" class="space-y-4">
            <div>
              <label class="block text-cream/70 text-sm font-medium mb-1.5">Email</label>
              <input
                v-model="resetEmail"
                type="email"
                required
                placeholder="your@email.com"
                class="w-full px-4 py-3 rounded-lg bg-white text-dark placeholder-dark/40 border border-white/20 focus:outline-none focus:ring-2 focus:ring-gold/60 transition"
              />
            </div>
            <button
              type="submit"
              :disabled="resetLoading"
              class="w-full py-3 rounded-lg bg-gold text-dark font-bold uppercase tracking-wider hover:bg-gold/90 focus:outline-none focus:ring-2 focus:ring-gold/60 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span v-if="resetLoading">Sending...</span>
              <span v-else>Send Reset Link</span>
            </button>
          </form>
        </div>
      </Transition>

      <!-- Footer decoration -->
      <p class="text-center text-cream/30 text-xs mt-8 tracking-widest uppercase">
        A Tradition Unlike Any Other
      </p>
    </div>
  </div>
</template>
