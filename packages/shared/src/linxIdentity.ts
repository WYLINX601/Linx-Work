/**
 * Runtime identity for the Linx fork.
 *
 * Keep OS-visible names and default locations here so Linx can start beside
 * upstream T3 Code and Synara without sharing home directories, profiles,
 * URL schemes, ports, or app identifiers.
 */

export const LINX_APP_BASE_NAME = "LinxWorkOS";
export const LINX_APP_SLUG = "linx";

// The legacy Linx app uses .linx and has an incompatible migration history.
export const LINX_HOME_DIR_NAME = ".linxworkos";

export const LINX_SERVER_DEFAULT_PORT = 3774;
export const LINX_DEV_SERVER_PORT = 13774;
export const LINX_DEV_WEB_PORT = 5734;

export const LINX_DESKTOP_APP_ID = "com.linx.work";
export const LINX_DESKTOP_DEV_APP_ID = `${LINX_DESKTOP_APP_ID}.dev`;

export const LINX_DESKTOP_SCHEME = "linx";
export const LINX_DESKTOP_DEV_SCHEME = `${LINX_DESKTOP_SCHEME}-dev`;

export const LINX_DESKTOP_PAIRING_HOST = "pair";

/** Accepts the production scheme and its developer/preview channel variants. */
export const LINX_APP_LINK_PROTOCOL = /^linx(?:-[a-z]+)?:$/;

export const LINX_DESKTOP_USER_DATA_DIR = "linxworkos";
export const LINX_DESKTOP_DEV_USER_DATA_DIR = `${LINX_DESKTOP_USER_DATA_DIR}-dev`;

export const LINX_LINUX_DESKTOP_ENTRY = `${LINX_DESKTOP_APP_ID}.desktop`;
export const LINX_LINUX_DEV_DESKTOP_ENTRY = `${LINX_DESKTOP_APP_ID}.Development.desktop`;
