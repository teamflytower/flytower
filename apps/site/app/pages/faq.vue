<script setup lang="ts">
const { data: page } = await useAsyncData('page:faq', () =>
  queryCollection('pages').path('/faq').first(),
)
if (!page.value)
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
useSeoMeta({ title: page.value.title, description: page.value.description })
</script>

<template>
  <UContainer class="max-w-3xl py-12">
    <ContentRenderer v-if="page" :value="page" />
  </UContainer>
</template>
