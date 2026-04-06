import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useChatStore = defineStore('chat', () => {
  const unreadCount = ref(0)

  function increment() {
    unreadCount.value++
  }

  function reset() {
    unreadCount.value = 0
  }

  return { unreadCount, increment, reset }
})
