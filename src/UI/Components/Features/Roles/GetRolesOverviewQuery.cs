// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     GetRolesOverviewQuery.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

namespace UI.Components.Features.Roles;

/// <summary>
///   Asks for the Roles page's content: every Role as a tile, and the table of Users.
/// </summary>
/// <param name="RoleId">
///   The Role whose members the table lists, from <c>?role=</c>, or <see langword="null" /> for the first page of
///   Users from the search.
/// </param>
public sealed record GetRolesOverviewQuery(string? RoleId);
