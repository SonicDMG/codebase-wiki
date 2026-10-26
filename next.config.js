/**
 * next.config.js
 *
 * The wiki is a standalone Next.js app. It shares nothing with the Walfly API at
 * build time (no @walfly/* packages), so there is nothing to transpile or trace
 * across the monorepo.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;
