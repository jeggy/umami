import { useQueryClient } from '@tanstack/react-query';
import {
  Box,
  Button,
  Column,
  Form,
  FormButtons,
  FormField,
  FormFieldArray,
  FormSubmitButton,
  Grid,
  Icon,
  Row,
  Select,
  Text,
  TextField,
} from '@umami/react-zen';
import { useEffect, useState } from 'react';
import { DateDistance } from '@/components/common/DateDistance';
import { type OidcProviderResponse, useApi, useMessages, useUpdateQuery } from '@/components/hooks';
import { Plus, Trash } from '@/components/icons';
import { ROLES } from '@/lib/constants';
import { TEAM_ROLES, USER_ROLES } from '@/lib/oidc-groups';

// A select needs a value for "no role" and "no team"; the API takes null.
const NONE = 'none';
const COLUMNS = 'minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 1.6fr) minmax(0, 1.4fr) 36px';

interface MappingValues {
  group: string;
  role: string;
  teamId: string;
  teamRole: string;
}

type Mapping = OidcProviderResponse['mappings'][number];

const toValues = ({ group, role, teamId, teamRole }: Mapping): MappingValues => ({
  group,
  role: role ?? NONE,
  teamId: teamId ?? NONE,
  teamRole: teamRole ?? NONE,
});

const fromValues = ({ group, role, teamId, teamRole }: MappingValues) => ({
  group: group.trim(),
  role: role === NONE ? null : role,
  teamId: teamId === NONE ? null : teamId,
  teamRole: teamId === NONE ? null : teamRole,
});

const roleLabel = (role: string) => Object.keys(ROLES).find(key => ROLES[key] === role);

function useAllTeams() {
  const { get, useQuery } = useApi();

  return useQuery<{ data: { id: string; name: string }[] }>({
    queryKey: ['teams:admin', { all: true }],
    queryFn: () => get('/admin/teams', { pageSize: 1000 }),
  });
}

export function OidcGroupMappingsForm({ provider }: { provider: OidcProviderResponse }) {
  const { t, labels, messages, getErrorMessage } = useMessages();
  const { mutateAsync, error, isPending, toast } = useUpdateQuery(
    `/admin/oidc-providers/${provider.slug}`,
  );
  const queryClient = useQueryClient();
  const [saves, setSaves] = useState(0);
  const { data: teams } = useAllTeams();

  const roleItems = [
    { value: NONE, label: t(labels.none) },
    ...USER_ROLES.map(role => ({ value: role, label: t(labels[roleLabel(role)]) })),
  ];
  const teamRoleItems = TEAM_ROLES.map(role => ({
    value: role,
    label: t(labels[roleLabel(role)]),
  }));
  const teamItems = [
    { value: NONE, label: t(labels.none) },
    ...(teams?.data ?? []).map(({ id, name }) => ({ value: id, label: name })),
  ];

  const handleSubmit = async ({ mappings }: { mappings: MappingValues[] }) => {
    await mutateAsync(
      { mappings: mappings.map(fromValues) },
      {
        onSuccess: async () => {
          toast(t(messages.saved));
          await queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
          setSaves(saves + 1);
        },
      },
    );
  };

  const newRow = (group = ''): MappingValues => ({
    group,
    role: NONE,
    teamId: NONE,
    teamRole: NONE,
  });

  return (
    <Form
      key={saves}
      onSubmit={handleSubmit}
      error={getErrorMessage(error)}
      defaultValues={{ mappings: provider.mappings.map(toValues) }}
    >
      <FormFieldArray name="mappings">
        {({ fields, append, remove, watch, getValues, setValue }) => (
          <Column gap="4">
            <LastGroups lastGroups={provider.lastGroups} onAdd={group => append(newRow(group))} />
            {fields.length > 0 && (
              <Box overflowX="auto">
                <Column gap="2" style={{ minWidth: 640 }}>
                  <Grid columns={COLUMNS} gap="3">
                    {[labels.group, labels.role, labels.team, labels.teamRole].map(label => (
                      <Text key={label} size="sm" weight="bold">
                        {t(label)}
                      </Text>
                    ))}
                  </Grid>
                  {fields.map(({ id }, index) => (
                    <MappingRow
                      key={id}
                      path={`mappings.${index}`}
                      teamId={watch(`mappings.${index}.teamId`)}
                      getValues={getValues}
                      setValue={setValue}
                      roleItems={roleItems}
                      teamItems={teamItems}
                      teamRoleItems={teamRoleItems}
                      onRemove={() => remove(index)}
                    />
                  ))}
                </Column>
              </Box>
            )}
            <Row>
              <Button onPress={() => append(newRow())} data-test="button-add-mapping">
                <Icon>
                  <Plus />
                </Icon>
                <Text>{t(labels.addMapping)}</Text>
              </Button>
            </Row>
          </Column>
        )}
      </FormFieldArray>
      <FormButtons>
        <FormSubmitButton variant="primary" isLoading={isPending} data-test="button-save-mappings">
          {t(labels.save)}
        </FormSubmitButton>
      </FormButtons>
    </Form>
  );
}

type Items = { value: string; label: string }[];

function MappingRow({
  path,
  teamId,
  getValues,
  setValue,
  roleItems,
  teamItems,
  teamRoleItems,
  onRemove,
}: {
  path: string;
  teamId: string;
  getValues: (name: string) => string;
  setValue: (name: string, value: string, options?: { shouldDirty: boolean }) => void;
  roleItems: Items;
  teamItems: Items;
  teamRoleItems: Items;
  onRemove: () => void;
}) {
  const { t, labels } = useMessages();
  const hasTeam = teamId !== NONE;

  // A team needs a team role and a team role needs a team, so the team role follows the team.
  useEffect(() => {
    const teamRole = getValues(`${path}.teamRole`);

    if (hasTeam !== (teamRole !== NONE)) {
      setValue(`${path}.teamRole`, hasTeam ? ROLES.teamMember : NONE, { shouldDirty: true });
    }
  }, [hasTeam, path, getValues, setValue]);

  return (
    <Grid columns={COLUMNS} gap="3" alignItems="start">
      <FormField name={`${path}.group`} rules={{ required: t(labels.required) }}>
        <TextField aria-label={t(labels.group)} placeholder="/umami-admins" autoComplete="off" />
      </FormField>
      <FormField name={`${path}.role`}>
        <Select items={roleItems} triggerProps={{ 'aria-label': t(labels.role) }} />
      </FormField>
      <FormField name={`${path}.teamId`}>
        <Select
          items={teamItems}
          maxHeight="300px"
          triggerProps={{ 'aria-label': t(labels.team) }}
        />
      </FormField>
      <FormField name={`${path}.teamRole`}>
        <Select
          items={hasTeam ? teamRoleItems : [{ value: NONE, label: t(labels.none) }]}
          isDisabled={!hasTeam}
          triggerProps={{ 'aria-label': t(labels.teamRole) }}
        />
      </FormField>
      <Button variant="quiet" onPress={onRemove} aria-label={t(labels.remove)}>
        <Icon>
          <Trash />
        </Icon>
      </Button>
    </Grid>
  );
}

function LastGroups({
  lastGroups,
  onAdd,
}: {
  lastGroups: OidcProviderResponse['lastGroups'];
  onAdd: (group: string) => void;
}) {
  const { t, labels, messages } = useMessages();

  if (!lastGroups) {
    return <Text color="muted">{t(messages.noLastGroups)}</Text>;
  }

  return (
    <Column gap="2">
      <Row gap="2" alignItems="baseline">
        <Text weight="bold">{t(labels.lastGroups)}</Text>
        <Text color="muted">
          <DateDistance date={new Date(lastGroups.signedInAt)} />
        </Text>
      </Row>
      {lastGroups.groups.length ? (
        <Row gap="2" wrap="wrap">
          {lastGroups.groups.map(group => (
            <Button
              key={group}
              size="sm"
              onPress={() => onAdd(group)}
              aria-label={`${t(labels.addMapping)}: ${group}`}
            >
              <Icon size="sm">
                <Plus />
              </Icon>
              <Text>{group}</Text>
            </Button>
          ))}
        </Row>
      ) : (
        <Text color="muted">{t(messages.noGroupsSent)}</Text>
      )}
    </Column>
  );
}
