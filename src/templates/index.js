/*
 * Template manifest (src/templates/index.js). Single import point for prompts.
 */

"use strict";

const { SYSTEM_PREAMBLE } = require("./system");
const { buildRoutePrompt } = require("./route");
const { buildRespondPrompt } = require("./respond");
const { buildConsolidatePrompt } = require("./consolidate");
const tone = require("./tone");
const onboard = require("./onboard");

module.exports = {
  SYSTEM_PREAMBLE,
  buildRoutePrompt,
  buildRespondPrompt,
  buildConsolidatePrompt,
  buildToneDirective: tone.buildToneDirective,
  resolveDials: tone.resolveDials,
  DEFAULT_DIALS: tone.DEFAULT_DIALS,
  SECTIONS: onboard.SECTIONS,
  MC: onboard.MC,
  buildOnboardFollowupPrompt: onboard.buildOnboardFollowupPrompt,
  buildOnboardExtractionPrompt: onboard.buildOnboardExtractionPrompt,
};
