/**
 * Wraps a module's UI: when the site's jawdatrace license is inactive, show
 * a short message instead of the module (see src/shared/license.js).
 * Resolvers enforce the same rule on the server.
 */
import React from 'react';
import { SectionMessage, Text, useProductContext } from '@forge/react';
import { LICENSE_MESSAGE, isLicenseInactive } from '../../shared/license';

export function LicenseGate({ children }) {
  const context = useProductContext();
  if (context && isLicenseInactive(context.license)) {
    return (
      <SectionMessage appearance="warning" title="License not active">
        <Text>{LICENSE_MESSAGE}</Text>
      </SectionMessage>
    );
  }
  return children;
}
