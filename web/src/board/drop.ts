// Drop position maths lifted from bb `plugins/tasks/views/board/drop-position.ts`, commit 5e1acd7
// (https://github.com/get-bb/bb). Changed by Nunchiro: task ids are card keys; bb's status list and
// status-keyed applyBoardMove are not lifted (board columns come from the core).
// MIT License
//
// Copyright (c) 2026 Michael Yong
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

interface BoardDropNeighbors {
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

export function dropNeighborsForIndex(columnTaskIds: readonly string[], draggedTaskId: string, dropIndex: number): BoardDropNeighbors {
  const ids = columnTaskIds.filter((id) => id !== draggedTaskId);
  const index = Math.max(0, Math.min(dropIndex, ids.length));
  return {
    beforeTaskId: ids[index - 1] ?? null,
    afterTaskId: ids[index] ?? null,
  };
}

export function dropIndexForPointer(cardCenterYs: readonly number[], pointerY: number): number {
  let index = 0;
  for (const centerY of cardCenterYs) {
    if (pointerY > centerY) index += 1;
  }
  return index;
}
