/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export function setDomHiddenUntilFound(dom: HTMLElement): void {
  // "until-found" is valid per the HTML spec but newer than the DOM lib's
  // `hidden: boolean` typing — widen the type at this one assignment.
  (dom as {hidden: boolean | string}).hidden = 'until-found';
}

export function domOnBeforeMatch(dom: HTMLElement, callback: () => void): void {
  dom.onbeforematch = callback;
}
