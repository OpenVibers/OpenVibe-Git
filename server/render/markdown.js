'use strict';
// openvibe-sdk/markdown (0.178.0) is this renderer now: the consolidation of 2026-11-16 left this file to merge by hand,
// and OpenVibe.Community's copy (the richer one: pipe tables, nested lists, a heading shift, openvibe.pics embeds)
// became the SDK's. Fenced code goes through this site's highlight.js wrapper, as before.
const { renderMarkdown: render, markdownToText } = require('openvibe-sdk/markdown');
const { highlight } = require('./highlight');

/** Markdown source → safe HTML (the SDK's renderer with this site's highlighter). */
const renderMarkdown = (source, options = {}) => render(source, { highlight, ...options });

module.exports = { renderMarkdown, markdownToText };
