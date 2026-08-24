'use strict';

/**
 * Compatibility metadata for the existing DeepSeek-specific driver. Its page
 * expressions deliberately remain in resources/driver.js until that driver is
 * migrated to consume provider adapters.
 */
module.exports = {
  id: 'deepseek',
  label: 'DeepSeek Web',
  siteUrl: 'https://chat.deepseek.com/',
  defaultProfilePrefix: 'deepseek',
  expressions: {},
};
