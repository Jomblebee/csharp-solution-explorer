using MediatR;
using TaskFlow.Domain.Enums;

namespace TaskFlow.Application.Tasks.Commands.CreateTask;

public record CreateTaskCommand(int ProjectId, string Title, string? Description, Priority Priority) : IRequest<int>;
