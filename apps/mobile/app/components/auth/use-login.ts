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

import { strings } from "@notesnook/intl";
import { useEffect, useRef, useState } from "react";
import { TextInput } from "react-native";
import { DatabaseLogger, db } from "../../common/database";
import { ToastManager, eSendEvent } from "../../services/event-manager";
import { eCloseSimpleDialog } from "../../utils/events";
import TwoFactorVerification from "./two-factor";
import { createFormRef } from "../ui/input/form-input";
import {
  ACCOUNT_SETUP_NOTICE_MS,
  completeAccountBootstrap
} from "./account-bootstrap";

export const LoginSteps = {
  emailAuth: 1,
  mfaAuth: 2,
  passwordAuth: 3
};

export const useLogin = (
  onFinishLogin?: () => void | Promise<void>,
  sessionExpired = false
) => {
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const running = useRef(false);
  const committed = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [step, setStep] = useState(LoginSteps.emailAuth);
  const emailInputRef = useRef<TextInput>(null);
  const passwordInputRef = useRef<TextInput>(null);
  const formRef = useRef(
    createFormRef({
      email: "",
      password: ""
    })
  );

  const login = async () => {
    if (running.current) return;
    let notice: ReturnType<typeof setTimeout> | undefined;
    try {
      running.current = true;
      setError(undefined);
      setLoading(true);
      notice = setTimeout(() => {
        if (!active.current) return;
        setLoading(false);
        setError(new Error(strings.accountSetupTimedOut()));
      }, ACCOUNT_SETUP_NOTICE_MS);
      switch (step) {
        case LoginSteps.emailAuth: {
          committed.current = false;
          if (formRef.current.validateField("email")) {
            setLoading(false);
            return;
          }
          const mfaInfo = await db.user.authenticateEmail(
            formRef.current.getValue("email").trim().toLowerCase()
          );

          const authenticationStep = db.user.getPendingAuthenticationStep();
          if (authenticationStep === "password") {
            setStep(LoginSteps.passwordAuth);
            passwordInputRef.current?.focus();
          } else if (authenticationStep === "mfa" && mfaInfo) {
            TwoFactorVerification.present(
              async (
                mfa: { code: string; method: string },
                callback: (success: boolean) => void,
                onerror: (e: Error) => void
              ) => {
                try {
                  const success = await db.user.authenticateMultiFactorCode(
                    mfa.code,
                    mfa.method
                  );

                  if (success) {
                    setStep(LoginSteps.passwordAuth);
                    setLoading(false);
                    setTimeout(() => {
                      passwordInputRef.current?.focus();
                    }, 500);
                    callback && callback(true);
                    return;
                  }
                  callback && callback(false);
                } catch (e) {
                  callback && callback(false);
                  if ((e as Error).message === "invalid_grant") {
                    eSendEvent(eCloseSimpleDialog, "two_factor_verify");
                    setLoading(false);
                    setStep(LoginSteps.emailAuth);
                    ToastManager.error(
                      new Error(strings.tokenExpiredTryLogin())
                    );
                  } else {
                    DatabaseLogger.error(e, "VeyraN MFA failed");
                    onerror(new Error(strings.authMfaFailed()));
                  }
                }
              },
              mfaInfo,
              () => {
                eSendEvent(eCloseSimpleDialog, "two_factor_verify");
                setLoading(false);
                setStep(LoginSteps.emailAuth);
              }
            );
          } else {
            finishWithError(new Error(strings.unableToSend2faCode()));
          }
          break;
        }
        case LoginSteps.passwordAuth: {
          if (!formRef.current.validate()) {
            setLoading(false);
            return;
          }
          const values = formRef.current.getValues();
          if (!committed.current) {
            await db.user.authenticatePassword(
              values.email.trim().toLowerCase(),
              values.password,
              undefined,
              sessionExpired
            );
            committed.current = true;
          }
          await finishLogin();
          break;
        }
      }
      setLoading(false);
    } catch (e) {
      finishWithError(e as Error);
    } finally {
      clearTimeout(notice);
      running.current = false;
      if (active.current) setLoading(false);
    }
  };

  const finishWithError = (e: Error) => {
    DatabaseLogger.error(e, "VeyraN sign in failed");
    if (!active.current) return;
    if (e.message === "invalid_grant") setStep(LoginSteps.emailAuth);
    setLoading(false);
    if (e.message === "Password is incorrect.") {
      formRef.current.setError("password", strings.emailOrPasswordIncorrect());
    } else {
      setError(
        new Error(
          committed.current
            ? strings.accountSetupIncomplete()
            : strings.authRequestFailed()
        )
      );
    }
  };

  const finishLogin = async () => {
    const user = await completeAccountBootstrap(() => {
      if (active.current) return onFinishLogin?.();
    });
    ToastManager.show({
      heading: strings.loginSuccess(),
      message: strings.loginSuccessDesc(user.email),
      type: "success",
      context: "global"
    });
    setLoading(false);
  };

  return {
    login,
    step,
    setStep,
    passwordInputRef,
    emailInputRef,
    loading,
    setLoading,
    error,
    setError,
    formRef
  };
};
