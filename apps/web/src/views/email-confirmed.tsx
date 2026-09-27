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

import "../app.css";
import { useEffect } from "react";
import { Flex, Text } from "@theme-ui/components";
import { useQueryParams } from "../navigation";
import { MailCheck } from "../components/icons";
import { strings } from "@notesnook/intl";

function EmailConfirmed() {
  const [{ userId }] = useQueryParams();
  useEffect(() => {
    if (!userId) window.location.href = "/";
  }, [userId]);

  return (
    <Flex
      sx={{
        bg: "background",
        flexDirection: "column",
        fontSize: [14, 16, 18],
        height: "100%",
        overflowY: "auto"
      }}
    >
      <Flex
        sx={{
          flex: 1,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <MailCheck
          sx={{ bg: "shade", borderRadius: 100, p: 5 }}
          size={72}
          color="accent"
        />
        <Text
          variant="heading"
          mt={5}
          sx={{
            fontSize: "2.5em",
            textAlign: "center",
            fontWeight: "heading"
          }}
        >
          Huzzah!
        </Text>
        <Text
          variant="heading"
          mt={2}
          sx={{
            fontSize: "1.5em",
            textAlign: "center",
            fontWeight: "bold",
            color: "icon"
          }}
        >
          {strings.emailConfirmed()}
        </Text>
        <Text
          variant="body"
          mt={2}
          sx={{
            wordWrap: "break-word",
            fontSize: "1.2em",
            textAlign: "center",
            color: "var(--paragraph-secondary)"
          }}
        >
          {strings.confirmEmailThankyou()}
        </Text>
      </Flex>
    </Flex>
  );
}
export default EmailConfirmed;
