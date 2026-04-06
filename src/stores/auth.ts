import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/lib/supabase'
import type { User } from '@supabase/supabase-js'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const displayName = ref('')
  const loading = ref(true)

  const isAuthenticated = computed(() => !!user.value)

  async function init() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        user.value = session.user
        displayName.value = session.user.user_metadata?.display_name || session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email || ''
        localStorage.setItem('sb-auth-token', session.access_token)
      }
    } catch (e) {
      console.error('Auth init failed:', e)
    } finally {
      loading.value = false
    }

    supabase.auth.onAuthStateChange((_event, session) => {
      user.value = session?.user ?? null
      if (session) {
        displayName.value = session.user.user_metadata?.display_name || session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email || ''
        localStorage.setItem('sb-auth-token', session.access_token)
      } else {
        displayName.value = ''
        localStorage.removeItem('sb-auth-token')
      }
    })
  }

  async function login(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function loginWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/draft`,
      },
    })
    if (error) throw error
  }

  async function register(email: string, password: string, name: string) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name } },
    })
    if (error) throw error
  }

  async function logout() {
    await supabase.auth.signOut()
    localStorage.removeItem('sb-auth-token')
  }

  async function resetPassword(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email)
    if (error) throw error
  }

  return { user, displayName, loading, isAuthenticated, init, login, loginWithGoogle, register, logout, resetPassword }
})
