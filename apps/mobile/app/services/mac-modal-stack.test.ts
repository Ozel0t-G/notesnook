/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import {
  __resetMacModalStackForTests,
  consumeMacEscape,
  createMacSheetFacade,
  registerMacModal
} from "./mac-modal-stack";

describe("mac-modal-stack registry", () => {
  beforeEach(() => {
    __resetMacModalStackForTests();
  });

  it("returns false when nothing is active", () => {
    expect(consumeMacEscape()).toBe(false);
  });

  it("ignores entries that were registered but never presented", () => {
    registerMacModal("sheet", () => true, jest.fn());
    expect(consumeMacEscape()).toBe(false);
  });

  it("closes the most recently presented active sheet", () => {
    const closeA = jest.fn();
    const closeB = jest.fn();
    const a = registerMacModal("sheet", () => true, closeA);
    const b = registerMacModal("sheet", () => true, closeB);
    a.present();
    b.present();

    expect(consumeMacEscape()).toBe(true);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  it("an older dialog does not block Escape from reaching a newer sheet", () => {
    const closeDialog = jest.fn();
    const closeSheet = jest.fn();
    const dialog = registerMacModal("dialog", () => true, closeDialog);
    const sheet = registerMacModal("sheet", () => true, closeSheet);
    dialog.present();
    sheet.present();

    expect(consumeMacEscape()).toBe(true);
    expect(closeSheet).toHaveBeenCalledTimes(1);
    expect(closeDialog).not.toHaveBeenCalled();
  });

  it("an older sheet does not block Escape from reaching a newer dialog", () => {
    const closeSheet = jest.fn();
    const closeDialog = jest.fn();
    const sheet = registerMacModal("sheet", () => true, closeSheet);
    const dialog = registerMacModal("dialog", () => true, closeDialog);
    sheet.present();
    dialog.present();

    expect(consumeMacEscape()).toBe(true);
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeSheet).not.toHaveBeenCalled();
  });

  it("a blocked topmost entry consumes Escape without closing", () => {
    const close = jest.fn();
    const entry = registerMacModal("sheet", () => false, close);
    entry.present();

    expect(consumeMacEscape()).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not close an already-closing entry twice", () => {
    const close = jest.fn();
    const entry = registerMacModal("sheet", () => true, close);
    entry.present();

    expect(consumeMacEscape()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);

    expect(consumeMacEscape()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("re-presenting after dismissal clears closing and bumps order", () => {
    const close = jest.fn();
    const other = registerMacModal("sheet", () => true, jest.fn());
    const entry = registerMacModal("sheet", () => true, close);

    other.present();
    entry.present();
    consumeMacEscape();
    entry.dismissed();

    other.present(); // re-present, now newest again
    expect(consumeMacEscape()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1); // not called again

    entry.present(); // entry becomes newest again
    expect(consumeMacEscape()).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("re-presenting while already active does not change order", () => {
    const closeA = jest.fn();
    const closeB = jest.fn();
    const a = registerMacModal("sheet", () => true, closeA);
    const b = registerMacModal("sheet", () => true, closeB);
    a.present();
    b.present();
    a.present(); // already active: must not become newest

    expect(consumeMacEscape()).toBe(true);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  it("an entry stuck active+closing because the vendor's onClose never fired recovers Escape ownership on an actual new presentation, taking over from another already-visible modal, and ordinary dismissal then lets that underlying modal close for the first time", () => {
    const closeA = jest.fn();
    const closeB = jest.fn();
    const a = registerMacModal("sheet", () => true, closeA);
    const b = registerMacModal("sheet", () => true, closeB);

    a.present();

    // Escape closes A once.
    expect(consumeMacEscape()).toBe(true);
    expect(closeA).toHaveBeenCalledTimes(1);

    // The vendor's real onClose never actually fires (dropped/interrupted),
    // so A never calls dismissed() and is stuck active+closing. Repeated
    // Escape must keep consuming without closing it again.
    expect(consumeMacEscape()).toBe(true);
    expect(closeA).toHaveBeenCalledTimes(1);

    // Another modal becomes visible while A is still stuck closing. It stays
    // truly open (active, not closing) - Escape is never routed to it here.
    b.present();
    expect(closeB).toHaveBeenCalledTimes(0);

    // Native actually re-presents A (its real onOpen fires again): this is
    // the only trustworthy recovery signal, and it must make A the new top,
    // ahead of B which was already visible.
    a.present();
    expect(consumeMacEscape()).toBe(true);
    expect(closeA).toHaveBeenCalledTimes(2);
    expect(closeB).toHaveBeenCalledTimes(0);

    // This time the vendor's real onClose actually runs (ordinary dismissal),
    // so Escape falls through to B, which closes for the first time.
    a.dismissed();
    expect(consumeMacEscape()).toBe(true);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("unregister removes the entry entirely", () => {
    const close = jest.fn();
    const entry = registerMacModal("sheet", () => true, close);
    entry.present();
    entry.unregister();

    expect(consumeMacEscape()).toBe(false);
  });

  describe("createMacSheetFacade", () => {
    it("show() forwards the call without presenting; presentation happens once the real onOpen callback runs", () => {
      const target = {
        show: jest.fn(),
        hide: jest.fn(),
        setModalVisible: jest.fn(),
        isOpen: jest.fn(() => true)
      };
      const targetRef = { current: target };
      const controller = registerMacModal("sheet", () => true, () =>
        facade.hide()
      );
      const facade = createMacSheetFacade(targetRef, controller);

      facade.show(2);
      expect(target.show).toHaveBeenCalledWith(2);
      // Not yet presented: the facade must not arm the registry on its own -
      // native can still refuse to actually open afterwards.
      expect(controller.isActive()).toBe(false);
      expect(consumeMacEscape()).toBe(false);

      // The real ActionSheet's onOpen callback is what actually presents.
      controller.present();
      expect(consumeMacEscape()).toBe(true);
      expect(target.hide).toHaveBeenCalledTimes(1);
    });

    it("setModalVisible(false) before any presentation does not mark closing", () => {
      const target = {
        show: jest.fn(),
        hide: jest.fn(),
        setModalVisible: jest.fn()
      };
      const targetRef = { current: target };
      const controller = registerMacModal("sheet", () => true, jest.fn());
      const facade = createMacSheetFacade(targetRef, controller);

      facade.setModalVisible(false);

      expect(target.setModalVisible).toHaveBeenCalledWith(false);
      expect(controller.isActive()).toBe(false);
      expect(consumeMacEscape()).toBe(false);
    });

    it("setModalVisible(true) forwards without presenting; setModalVisible(false) after presentation marks closing without a redundant close call", () => {
      const close = jest.fn();
      const target = {
        show: jest.fn(),
        hide: jest.fn(),
        setModalVisible: jest.fn()
      };
      const targetRef = { current: target };
      const controller = registerMacModal("sheet", () => true, close);
      const facade = createMacSheetFacade(targetRef, controller);

      facade.setModalVisible(true);
      expect(target.setModalVisible).toHaveBeenCalledWith(true);
      expect(controller.isActive()).toBe(false);

      // The real onOpen callback (simulated here) is what actually presents.
      controller.present();
      expect(controller.isActive()).toBe(true);

      // The sheet dismisses itself (swipe/backdrop tap), not through Escape.
      facade.setModalVisible(false);
      expect(target.setModalVisible).toHaveBeenCalledWith(false);

      // Escape arriving while it is already closing must not call close() again.
      expect(consumeMacEscape()).toBe(true);
      expect(close).not.toHaveBeenCalled();
    });

    it("never creates a ghost entry when the target ref is null or stale", () => {
      const targetRef: { current: any } = { current: null };
      const controller = registerMacModal("sheet", () => true, jest.fn());
      const facade = createMacSheetFacade(targetRef, controller);

      expect(facade.show()).toBeUndefined();
      expect(facade.setModalVisible(true)).toBeUndefined();

      expect(controller.isActive()).toBe(false);
      expect(consumeMacEscape()).toBe(false);
    });

    it("forwards unknown methods unchanged, bound to the target", () => {
      const target = {
        show: jest.fn(),
        hide: jest.fn(),
        setModalVisible: jest.fn(),
        isOpen: jest.fn(() => "open-value"),
        currentSnapIndex: jest.fn(() => 3)
      };
      const targetRef = { current: target };
      const controller = registerMacModal("sheet", () => true, jest.fn());
      const facade = createMacSheetFacade(targetRef, controller);

      expect((facade as any).isOpen()).toBe("open-value");
      expect((facade as any).currentSnapIndex()).toBe(3);
    });

    it("forwards symbol-keyed properties without breaking", () => {
      const marker = Symbol("marker");
      const target: any = {
        show: jest.fn(),
        hide: jest.fn(),
        setModalVisible: jest.fn()
      };
      target[marker] = () => "symbol-value";
      const targetRef = { current: target };
      const controller = registerMacModal("sheet", () => true, jest.fn());
      const facade: any = createMacSheetFacade(targetRef, controller);

      expect(facade[marker]()).toBe("symbol-value");
    });
  });
});
